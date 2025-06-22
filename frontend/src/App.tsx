import React, { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import VideoTile from "./VideoTile";

type RemotePeer = {
	clientId: string;
	kind: "audio" | "video";
	producerId: string;
	isScreenShare?: boolean;
	consumer: {
		id: string;
		kind: "audio" | "video";
		track: MediaStreamTrack;
		close: () => void;
	};
};

const App: React.FC = () => {
	const [socket, setSocket] = useState<Socket>();
	const [device, setDevice] = useState<any>();
	const [sendTransport, setSendTransport] = useState<any>();
	const [recvTransport, setRecvTransport] = useState<any>();
	const [peers, setPeers] = useState<RemotePeer[]>([]);
	const [isConnected, setIsConnected] = useState(false);
	const [error, setError] = useState<string>("");
	const [isScreenSharing, setIsScreenSharing] = useState(false);

	const localStreamRef = useRef<MediaStream | null>(null);
	const localVideoRef = useRef<HTMLVideoElement>(null);
	const screenShareRef = useRef<MediaStream | null>(null);
	const screenProducerRef = useRef<any>(null);

	const clientId = useRef(`client-${Math.random().toString(36).substring(2, 9)}`);

	useEffect(() => {
		const run = async () => {
			try {
				const s = io("http://localhost:3000", {
					transports: ["websocket"],
				});

				s.on("connect", () => {
					console.log("Connected to server");
					setIsConnected(true);
				});

				s.on("disconnect", () => {
					console.log("Disconnected from server");
					setIsConnected(false);
				});

				s.on("error", (error: any) => {
					console.error("Socket error:", error);
					setError(error.message || "Connection error");
				});

				setSocket(s);

				// Wait for connection
				await new Promise<void>((resolve) => {
					if (s.connected) {
						resolve();
					} else {
						s.on("connect", resolve);
					}
				});

				// Get RTP capabilities
				const rtpCapabilitiesResponse = await new Promise<any>((resolve) => {
					s.emit("getRtpCapabilities", {}, (response: any) => {
						if (response.error) {
							throw new Error(response.error);
						}
						resolve(response);
					});
				});

				if (!rtpCapabilitiesResponse.rtpCapabilities) {
					throw new Error("Failed to get RTP capabilities");
				}

				// Create device
				const dev = new Device();
				await dev.load({ routerRtpCapabilities: rtpCapabilitiesResponse.rtpCapabilities });
				setDevice(dev);

				// Create transports first
				await createTransports(dev, s);

				// Join room after transports are ready
				s.emit("joinRoom", { roomId: "main", clientId: clientId.current });

				// Listen for existing producers
				s.on("existingProducers", (prods: any[]) => {
					console.log("Existing producers received:", prods);
					prods.forEach((p) => {
						console.log("Processing existing producer:", p);
						subscribeToProducer(p, dev, s);
					});
				});

				// Listen for new producers
				s.on("newProducer", (p: any) => {
					console.log("New producer received:", p);
					subscribeToProducer(p, dev, s);
				});

				// Listen for producer closed events
				s.on("producerClosed", ({ producerId }: { producerId: string }) => {
					console.log("Producer closed:", producerId);
					setPeers((prev) => {
						const peer = prev.find((p) => p.producerId === producerId);
						if (peer) {
							console.log("Closing consumer for closed producer:", producerId);
							peer.consumer.close();
						}
						return prev.filter((p) => p.producerId !== producerId);
					});
				});

				// Start local media
				await startLocal(dev, s);
			} catch (error) {
				console.error("Setup error:", error);
				setError(`Setup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		};

		run();

		// Cleanup on unmount
		return () => {
			if (socket) {
				socket.disconnect();
			}
			if (localStreamRef.current) {
				localStreamRef.current.getTracks().forEach((track) => track.stop());
			}
			if (screenShareRef.current) {
				screenShareRef.current.getTracks().forEach((track) => track.stop());
			}
		};
	}, []);

	const startLocal = async (dev?: any, s?: Socket) => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: { width: 640, height: 480 },
			});
			localStreamRef.current = stream;

			if (localVideoRef.current) {
				localVideoRef.current.srcObject = stream;
			}

			// Use passed parameters or state
			const currentDevice = dev || device;
			const currentSocket = s || socket;
			console.log("currentDevice", currentDevice);
			console.log("currentSocket", currentSocket);
			const currentSendTransport = sendTransport;

			// Produce local camera/mic tracks if sendTransport is ready
			if (currentSendTransport && localStreamRef.current) {
				for (const track of localStreamRef.current.getTracks()) {
					try {
						await currentSendTransport.produce({
							track,
							appData: { source: "camera" },
						});
						console.log(`Produced ${track.kind} track from camera`);
					} catch (error) {
						console.error("Error producing track:", error);
					}
				}
			}
		} catch (error) {
			console.error("Error accessing media devices:", error);
			setError("Failed to access camera/microphone");
		}
	};

	const createTransports = async (device: any, s: Socket) => {
		try {
			// Create send transport
			const sendTransportResponse = await new Promise<any>((resolve) => {
				s.emit("createTransport", { type: "send" }, (response: any) => {
					if (response.error) {
						throw new Error(response.error);
					}
					resolve(response);
				});
			});

			const sendTransport = device.createSendTransport(sendTransportResponse.transportOptions);

			sendTransport.on(
				"connect",
				async ({ dtlsParameters }: any, callback: () => void, errback: (error: Error) => void) => {
					try {
						s.emit(
							"connectTransport",
							{
								transportId: sendTransport.id,
								dtlsParameters,
							},
							(response: any) => {
								if (response.error) {
									errback(new Error(response.error));
								} else {
									callback();
								}
							}
						);
					} catch (error) {
						errback(error as Error);
					}
				}
			);

			sendTransport.on(
				"produce",
				async (
					{ kind, rtpParameters, appData }: any,
					callback: (data: any) => void,
					errback: (error: Error) => void
				) => {
					try {
						console.log("Producing:", { kind, appData });
						s.emit(
							"produce",
							{
								transportId: sendTransport.id,
								clientId: clientId.current,
								kind,
								rtpParameters,
								appData, // Pass through appData to identify screen share
							},
							(response: any) => {
								if (response.error) {
									errback(new Error(response.error));
								} else {
									console.log("Produce success:", response);
									callback({ id: response.producerId });
								}
							}
						);
					} catch (error) {
						errback(error as Error);
					}
				}
			);

			setSendTransport(sendTransport);

			// Create receive transport
			const recvTransportResponse = await new Promise<any>((resolve) => {
				s.emit("createTransport", { type: "recv" }, (response: any) => {
					if (response.error) {
						throw new Error(response.error);
					}
					resolve(response);
				});
			});

			const recvTransport = device.createRecvTransport(recvTransportResponse.transportOptions);

			recvTransport.on(
				"connect",
				async ({ dtlsParameters }: any, callback: () => void, errback: (error: Error) => void) => {
					try {
						s.emit(
							"connectTransport",
							{
								transportId: recvTransport.id,
								dtlsParameters,
							},
							(response: any) => {
								if (response.error) {
									errback(new Error(response.error));
								} else {
									callback();
								}
							}
						);
					} catch (error) {
						errback(error as Error);
					}
				}
			);

			setRecvTransport(recvTransport);

			console.log("Transports created successfully");
		} catch (error) {
			console.error("Error creating transports:", error);
			setError("Failed to create transports");
		}
	};

	const subscribeToProducer = async (
		producerData: {
			producerId: string;
			clientId: string;
			kind: "audio" | "video";
			appData?: any;
		},
		dev?: any,
		s?: Socket
	) => {
		const currentDevice = dev || device;
		const currentRecvTransport = recvTransport;
		const currentSocket = s || socket;

		if (!currentDevice || !currentRecvTransport || !currentSocket || producerData.clientId === clientId.current) {
			console.log("Cannot subscribe:", {
				hasDevice: !!currentDevice,
				hasRecvTransport: !!currentRecvTransport,
				hasSocket: !!currentSocket,
				isOwnProducer: producerData.clientId === clientId.current,
			});
			return;
		}

		try {
			console.log("Subscribing to producer:", producerData);

			const consumeResponse = await new Promise<any>((resolve, reject) => {
				currentSocket.emit(
					"consume",
					{
						transportId: currentRecvTransport.id,
						producerId: producerData.producerId,
						rtpCapabilities: currentDevice.rtpCapabilities,
					},
					(response: any) => {
						if (response.error) {
							reject(new Error(response.error));
						} else {
							resolve(response);
						}
					}
				);
			});

			console.log("Consume response:", consumeResponse);

			const consumer = await currentRecvTransport.consume({
				id: consumeResponse.consumerId,
				producerId: producerData.producerId,
				kind: producerData.kind,
				rtpParameters: consumeResponse.rtpParameters,
			});

			// Resume the consumer
			await consumer.resume();

			// Check if this is a screen share
			const isScreenShare = producerData.appData?.source === "screen";
			console.log("Consumer created:", {
				consumerId: consumer.id,
				isScreenShare,
				appData: producerData.appData,
			});

			setPeers((prev) => {
				// If this is a new screen share, close any existing screen shares from other clients
				if (isScreenShare && producerData.kind === "video") {
					console.log("New screen share detected, closing existing screen shares");
					prev.forEach((peer) => {
						if (peer.isScreenShare && peer.kind === "video" && peer.producerId !== producerData.producerId) {
							console.log("Closing existing screen share:", peer.producerId);
							peer.consumer.close();
						}
					});
					// Remove all existing screen shares
					prev = prev.filter((p) => !(p.isScreenShare && p.kind === "video"));
				}

				// Remove existing peer with same producer ID to avoid duplicates
				const filtered = prev.filter((p) => p.producerId !== producerData.producerId);

				const newPeer: RemotePeer = {
					clientId: producerData.clientId,
					kind: producerData.kind,
					producerId: producerData.producerId,
					isScreenShare,
					consumer: {
						id: consumer.id,
						kind: consumer.kind,
						track: consumer.track,
						close: () => consumer.close(),
					},
				};

				console.log("Adding peer:", newPeer);
				return [...filtered, newPeer];
			});
		} catch (error) {
			console.error("Error subscribing to producer:", error);
		}
	};

	const startShare = async () => {
		if (!sendTransport || !socket) {
			setError("Transport or socket not ready");
			return;
		}

		try {
			// First, notify server to close any existing screen shares
			socket.emit("closeAllScreenShares", { clientId: clientId.current });

			const screenStream = await (navigator.mediaDevices as any).getDisplayMedia({
				video: {
					width: 1920,
					height: 1080,
					frameRate: 15,
				},
				audio: false, // Set to true if you want to capture system audio
			});

			const screenTrack = screenStream.getVideoTracks()[0];
			screenShareRef.current = screenStream;

			screenTrack.onended = () => {
				console.log("Screen sharing ended by user");
				stopShare();
			};

			// Produce the screen track with appData to identify it as screen share
			const producer = await sendTransport.produce({
				track: screenTrack,
				appData: { source: "screen" },
			});

			screenProducerRef.current = producer;
			setIsScreenSharing(true);

			console.log("Screen sharing started with producer ID:", producer.id);
		} catch (error) {
			console.error("Error starting screen share:", error);
			setError("Failed to start screen sharing");
		}
	};

	const stopShare = async () => {
		if (screenProducerRef.current) {
			screenProducerRef.current.close();
			screenProducerRef.current = null;
		}

		if (screenShareRef.current) {
			screenShareRef.current.getTracks().forEach((track) => track.stop());
			screenShareRef.current = null;
		}

		setIsScreenSharing(false);
		console.log("Screen sharing stopped");
	};

	// Debug: Log peers state changes
	useEffect(() => {
		console.log("Peers updated:", peers);
		peers.forEach((peer) => {
			console.log(
				`Peer ${peer.clientId}: kind=${peer.kind}, isScreenShare=${peer.isScreenShare}, producerId=${peer.producerId}`
			);
		});
	}, [peers]);

	return (
		<div style={{ padding: "20px" }}>
			<h1>Group Video Call with Screen Share</h1>

			<div style={{ marginBottom: "20px" }}>
				<div>Status: {isConnected ? "✅ Connected" : "❌ Disconnected"}</div>
				<div>Client ID: {clientId.current}</div>
				<div>Peers: {peers.length}</div>
				<div>Screen shares: {peers.filter((p) => p.isScreenShare && p.kind === "video").length}</div>
				<div>Regular videos: {peers.filter((p) => !p.isScreenShare && p.kind === "video").length}</div>
				{error && <div style={{ color: "red" }}>Error: {error}</div>}
			</div>

			<div style={{ marginBottom: "20px" }}>
				{!isScreenSharing ? (
					<button onClick={startShare} disabled={!sendTransport}>
						🖥️ Start Screen Share
					</button>
				) : (
					<button onClick={stopShare} style={{ backgroundColor: "#ff4444", color: "white" }}>
						⏹️ Stop Screen Share
					</button>
				)}
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
				{/* Local Video */}
				<div>
					<h3>You (Local)</h3>
					<video
						ref={localVideoRef}
						muted
						autoPlay
						playsInline
						style={{ width: 320, height: 240, border: "2px solid blue" }}
					/>
				</div>

				{/* Screen Shares - Show these prominently */}
				{peers.filter((p) => p.isScreenShare && p.kind === "video").length > 0 ? (
					<div>
						<h2>🖥️ Screen Shares ({peers.filter((p) => p.isScreenShare && p.kind === "video").length})</h2>
						<div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
							{peers
								.filter((p) => p.isScreenShare && p.kind === "video")
								.map((p) => (
									<div
										key={`screen-${p.producerId}`}
										style={{ border: "3px solid green", padding: "10px", backgroundColor: "#f0fff0" }}>
										<h3>Screen from {p.clientId}</h3>
										<div style={{ marginBottom: "5px", fontSize: "12px", color: "#666" }}>
											Producer ID: {p.producerId}
										</div>
										<VideoTile
											consumer={p.consumer}
											style={{
												width: 640,
												height: 480,
												border: "1px solid #ccc",
												borderRadius: "8px",
											}}
										/>
									</div>
								))}
						</div>
					</div>
				) : (
					<div style={{ padding: "20px", backgroundColor: "#f9f9f9", borderRadius: "8px", textAlign: "center" }}>
						<h3>🖥️ No Screen Shares Active</h3>
						<p>When someone starts screen sharing, it will appear here.</p>
					</div>
				)}

				{/* Regular Video Peers */}
				{peers.filter((p) => !p.isScreenShare && p.kind === "video").length > 0 && (
					<div>
						<h3>👥 Participants</h3>
						<div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
							{peers
								.filter((p) => !p.isScreenShare && p.kind === "video")
								.map((p) => (
									<div key={`video-${p.producerId}`} style={{ border: "2px solid #ccc", padding: "5px" }}>
										<h4>{p.clientId}</h4>
										<VideoTile
											consumer={p.consumer}
											style={{
												width: 320,
												height: 240,
												border: "1px solid #999",
												borderRadius: "4px",
											}}
										/>
									</div>
								))}
						</div>
					</div>
				)}

				{/* Debug Information */}
				<div style={{ marginTop: "20px", padding: "10px", backgroundColor: "#f0f0f0", borderRadius: "5px" }}>
					<h4>Debug Info:</h4>
					<div>Total peers: {peers.length}</div>
					<div>
						Transports ready: Send={!!sendTransport}, Recv={!!recvTransport}
					</div>
					<div>Device ready: {!!device}</div>
					<div>Screen sharing: {isScreenSharing ? "Yes" : "No"}</div>
					{peers.length > 0 && (
						<div>
							<strong>Peer details:</strong>
							<ul>
								{peers.map((p) => (
									<li key={p.producerId}>
										{p.clientId} - {p.kind} - {p.isScreenShare ? "Screen" : "Camera"} - Producer: {p.producerId}
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

export default App;
