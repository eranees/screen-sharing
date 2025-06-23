import React, { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Device } from "mediasoup-client";
import VideoTile from "./VideoTile";
import { getSocket } from "./socket/socket";

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
	const [isJoined, setIsJoined] = useState(false);

	const localStreamRef = useRef<MediaStream | null>(null);
	const localVideoRef = useRef<HTMLVideoElement>(null);
	const screenShareRef = useRef<MediaStream | null>(null);
	const screenProducerRef = useRef<any>(null);
	const audioProducerRef = useRef<any>(null);
	const videoProducerRef = useRef<any>(null);

	useEffect(() => {
		const run = async () => {
			try {
				const s = getSocket();

				setIsConnected(true);

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
				const rtpCapabilitiesResponse = await new Promise<any>((resolve, reject) => {
					s.emit("getRtpCapabilities", {}, (response: any) => {
						if (response.error) {
							reject(new Error(response.error));
						} else {
							resolve(response);
						}
					});
				});

				if (!rtpCapabilitiesResponse.rtpCapabilities) {
					throw new Error("Failed to get RTP capabilities");
				}

				// Create device
				const dev = new Device();
				await dev.load({ routerRtpCapabilities: rtpCapabilitiesResponse.rtpCapabilities });
				setDevice(dev);

				// JOIN ROOM FIRST
				const joinResponse = await new Promise<any>((resolve, reject) => {
					s.emit("joinRoom", { roomId: "main", clientId: clientId.current }, (response: any) => {
						if (response.error) {
							reject(new Error(response.error));
						} else {
							resolve(response);
						}
					});
				});

				console.log("Joined room successfully:", joinResponse);
				setIsJoined(true);

				// Create transports after joining
				const { sendTransport: st, recvTransport: rt } = await createTransports(dev, s);
				setSendTransport(st);
				setRecvTransport(rt);

				// Start local media
				await startLocal(st);

				// Fixed: Set up event listeners AFTER everything is ready
				s.on("existingProducers", handleExistingProducers);
				s.on("newProducer", handleNewProducer);
				s.on("producerClosed", handleProducerClosed);
				s.on("clientDisconnected", handleClientDisconnected);
			} catch (error) {
				console.error("Setup error:", error);
				setError(`Setup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		};

		run();

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
	}, []); // Fixed: Remove dependencies to prevent re-running

	const clientId = useRef(`client-${Math.random().toString(36).substring(2, 9)}`);

	// Fixed: Create memoized subscribeToProducer function
	const subscribeToProducer = useCallback(
		async (producerData: { producerId: string; clientId: string; kind: "audio" | "video"; appData?: any }) => {
			if (!device || !recvTransport || !socket) {
				console.log("check clients", producerData.clientId, clientId.current);
				console.log("Cannot subscribe:", {
					hasDevice: !!device,
					hasRecvTransport: !!recvTransport,
					hasSocket: !!socket,
					isOwnProducer: producerData.clientId === clientId.current,
				});
				return;
			}

			try {
				console.log("Subscribing to producer:", producerData);

				// Check if already subscribed
				const existingPeer = peers.find((p) => p.producerId === producerData.producerId);
				if (existingPeer) {
					console.log(`Already subscribed to producer ${producerData.producerId}`);
					return;
				}

				const consumeResponse = await new Promise<any>((resolve, reject) => {
					console.log("here is socket", socket);
					socket?.emit(
						"consume",
						{
							transportId: recvTransport.id,
							producerId: producerData.producerId,
							rtpCapabilities: device.rtpCapabilities,
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

				const consumer = await recvTransport.consume({
					id: consumeResponse.consumerId,
					producerId: producerData.producerId,
					kind: producerData.kind,
					rtpParameters: consumeResponse.rtpParameters,
				});

				// CRITICAL: Resume the consumer immediately
				console.log("Resuming consumer:", consumer.id);
				await consumer.resume();

				// Verify consumer state
				console.log("Consumer state after resume:", {
					id: consumer.id,
					kind: consumer.kind,
					paused: consumer.paused,
					closed: consumer.closed,
					track: {
						id: consumer.track.id,
						kind: consumer.track.kind,
						readyState: consumer.track.readyState,
						enabled: consumer.track.enabled,
						muted: consumer.track.muted,
					},
				});

				const isScreenShare = producerData.appData?.source === "screen";

				setPeers((prev) => {
					const newPeer: RemotePeer = {
						clientId: producerData.clientId,
						kind: producerData.kind,
						producerId: producerData.producerId,
						isScreenShare,
						consumer: {
							id: consumer.id,
							kind: consumer.kind,
							track: consumer.track,
							close: () => {
								try {
									consumer.close();
								} catch (error) {
									console.error("Error closing consumer:", error);
								}
							},
						},
					};

					console.log("Adding peer:", newPeer);
					return [...prev, newPeer];
				});
			} catch (error) {
				console.error("Error subscribing to producer:", error);
			}
		},
		[device, recvTransport, socket, peers]
	);

	// Memoized socket event handlers
	const handleExistingProducers = useCallback(
		(prods: any[]) => {
			console.log("Existing producers received:", prods);
			prods.forEach((p) => {
				console.log("Processing existing producer:", p);
				subscribeToProducer(p);
			});
		},
		[subscribeToProducer]
	);

	const handleNewProducer = useCallback(
		(p: any) => {
			console.log("New producer received:", p);
			subscribeToProducer(p);
		},
		[subscribeToProducer]
	);

	const handleProducerClosed = useCallback(({ producerId }: { producerId: string }) => {
		console.log("Producer closed:", producerId);
		setPeers((prev) => {
			const peer = prev.find((p) => p.producerId === producerId);
			if (peer) {
				console.log("Closing consumer for closed producer:", producerId);
				try {
					peer.consumer.close();
				} catch (error) {
					console.error("Error closing consumer:", error);
				}
			}
			return prev.filter((p) => p.producerId !== producerId);
		});
	}, []);

	const handleClientDisconnected = useCallback(({ clientId: disconnectedClientId }: { clientId: string }) => {
		console.log("Client disconnected:", disconnectedClientId);
		setPeers((prev) => {
			const clientPeers = prev.filter((p) => p.clientId === disconnectedClientId);
			clientPeers.forEach((peer) => {
				try {
					peer.consumer.close();
				} catch (error) {
					console.error("Error closing consumer for disconnected client:", error);
				}
			});
			return prev.filter((p) => p.clientId !== disconnectedClientId);
		});
	}, []);

	const startLocal = async (sendTransportParam?: any) => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: { width: 640, height: 480 },
			});
			localStreamRef.current = stream;

			if (localVideoRef.current) {
				localVideoRef.current.srcObject = stream;
			}

			const currentSendTransport = sendTransportParam || sendTransport;

			if (currentSendTransport && localStreamRef.current) {
				for (const track of localStreamRef.current.getTracks()) {
					try {
						const producer = await currentSendTransport.produce({
							track,
							appData: { source: "camera" },
						});

						if (track.kind === "audio") {
							audioProducerRef.current = producer;
						} else {
							videoProducerRef.current = producer;
						}

						console.log(`Produced ${track.kind} track from camera:`, producer.id);
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

	const createTransports = async (device: any, s: Socket): Promise<{ sendTransport: any; recvTransport: any }> => {
		try {
			// Create send transport
			const sendTransportResponse = await new Promise<any>((resolve, reject) => {
				s.emit("createTransport", { type: "send" }, (response: any) => {
					if (response.error) {
						reject(new Error(response.error));
					} else {
						resolve(response);
					}
				});
			});

			const sendTransport = device.createSendTransport(sendTransportResponse.transportOptions);

			sendTransport.on(
				"connect",
				async ({ dtlsParameters }: any, callback: () => void, errback: (error: Error) => void) => {
					try {
						await new Promise<any>((resolve, reject) => {
							s.emit(
								"connectTransport",
								{
									transportId: sendTransport.id,
									dtlsParameters,
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
						callback();
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
						const response = await new Promise<any>((resolve, reject) => {
							s.emit(
								"produce",
								{
									transportId: sendTransport.id,
									clientId: clientId.current,
									kind,
									rtpParameters,
									appData,
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
						console.log("Produce success:", response);
						callback({ id: response.producerId });
					} catch (error) {
						console.error("Produce error:", error);
						errback(error as Error);
					}
				}
			);

			// Create receive transport
			const recvTransportResponse = await new Promise<any>((resolve, reject) => {
				s.emit("createTransport", { type: "recv" }, (response: any) => {
					if (response.error) {
						reject(new Error(response.error));
					} else {
						resolve(response);
					}
				});
			});

			const recvTransport = device.createRecvTransport(recvTransportResponse.transportOptions);

			recvTransport.on(
				"connect",
				async ({ dtlsParameters }: any, callback: () => void, errback: (error: Error) => void) => {
					try {
						await new Promise<any>((resolve, reject) => {
							s.emit(
								"connectTransport",
								{
									transportId: recvTransport.id,
									dtlsParameters,
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
						callback();
					} catch (error) {
						errback(error as Error);
					}
				}
			);

			console.log("Transports created successfully");
			return { sendTransport, recvTransport };
		} catch (error) {
			console.error("Error creating transports:", error);
			setError("Failed to create transports");
			throw error;
		}
	};

	const startShare = async (e: React.MouseEvent) => {
		e.preventDefault();

		if (!sendTransport || !socket) {
			setError("Transport or socket not ready");
			return;
		}

		try {
			console.log("Starting screen share...");

			// Close existing screen shares
			const closeResponse = await new Promise<any>((resolve, reject) => {
				socket.emit("closeAllScreenShares", { clientId: clientId.current }, (response: any) => {
					if (response.error) {
						reject(new Error(response.error));
					} else {
						resolve(response);
					}
				});
			});
			console.log("Closed existing screen shares:", closeResponse);

			// Get screen share stream with better constraints
			const screenStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					width: { ideal: 1920, max: 1920 },
					height: { ideal: 1080, max: 1080 },
					frameRate: { ideal: 30, max: 30 },
				},
				audio: false,
			});

			const screenTrack = screenStream.getVideoTracks()[0];
			if (!screenTrack) {
				throw new Error("No video track found in screen stream");
			}

			screenShareRef.current = screenStream;

			console.log("Screen track details:", {
				id: screenTrack.id,
				kind: screenTrack.kind,
				label: screenTrack.label,
				readyState: screenTrack.readyState,
				enabled: screenTrack.enabled,
				settings: screenTrack.getSettings(),
			});

			// Handle screen share ending
			screenTrack.onended = () => {
				console.log("Screen sharing ended by user");
				stopShare();
			};

			// Produce the screen track
			console.log("Producing screen track...");
			const producer = await sendTransport.produce({
				track: screenTrack,
				appData: { source: "screen", clientId: clientId.current },
			});

			screenProducerRef.current = producer;
			setIsScreenSharing(true);

			console.log("Screen sharing started successfully:", {
				producerId: producer.id,
				kind: producer.kind,
				appData: producer.appData,
			});

			// Add producer event listeners
			producer.on("transportclose", () => {
				console.log("Screen producer transport closed");
				stopShare();
			});

			producer.on("@close", () => {
				console.log("Screen producer closed");
				setIsScreenSharing(false);
			});
		} catch (error) {
			console.error("Error starting screen share:", error);
			setError(`Failed to start screen sharing: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	};

	const stopShare = async () => {
		console.log("Stopping screen share...");

		if (screenProducerRef.current && !screenProducerRef.current.closed) {
			screenProducerRef.current.close();
			screenProducerRef.current = null;
		}

		if (screenShareRef.current) {
			screenShareRef.current.getTracks().forEach((track) => {
				console.log("Stopping track:", track.id);
				track.stop();
			});
			screenShareRef.current = null;
		}

		setIsScreenSharing(false);
		console.log("Screen sharing stopped");
	};

	// Debug: Log peer changes
	useEffect(() => {
		console.log("Peers updated:", peers.length);
		peers.forEach((peer) => {
			console.log(
				`Peer ${peer.clientId}: ${peer.kind}, screen=${peer.isScreenShare}, producer=${peer.producerId}, track=${peer.consumer.track.readyState}`
			);
		});
	}, [peers]);

	const screenSharePeers = peers.filter((p) => p.isScreenShare && p.kind === "video");
	const videoPeers = peers.filter((p) => !p.isScreenShare && p.kind === "video");

	return (
		<div style={{ padding: "20px" }}>
			<h1>Group Video Call with Screen Share</h1>

			<div style={{ marginBottom: "20px", padding: "10px", backgroundColor: "#f5f5f5", borderRadius: "5px" }}>
				<div>Status: {isConnected ? "✅ Connected" : "❌ Disconnected"}</div>
				<div>Room: {isJoined ? "✅ Joined" : "❌ Not Joined"}</div>
				<div>Client: {clientId.current}</div>
				<div>
					Peers: {peers.length} (Screen: {screenSharePeers.length}, Video: {videoPeers.length})
				</div>
				<div>
					Transports: Send={!!sendTransport ? "✅" : "❌"}, Recv={!!recvTransport ? "✅" : "❌"}
				</div>
				<div>Device: {!!device ? "✅" : "❌"}</div>
				<div>Screen Sharing: {isScreenSharing ? "✅ Active" : "❌ Inactive"}</div>
				{error && <div style={{ color: "red", fontWeight: "bold" }}>❌ {error}</div>}
			</div>

			<div style={{ marginBottom: "20px" }}>
				{!isScreenSharing ? (
					<button
						onClick={startShare}
						disabled={!sendTransport || !isJoined}
						style={{
							padding: "10px 20px",
							fontSize: "16px",
							backgroundColor: sendTransport && isJoined ? "#4CAF50" : "#ccc",
							color: "white",
							border: "none",
							borderRadius: "5px",
							cursor: sendTransport && isJoined ? "pointer" : "not-allowed",
						}}>
						🖥️ Start Screen Share
					</button>
				) : (
					<button
						onClick={stopShare}
						style={{
							padding: "10px 20px",
							fontSize: "16px",
							backgroundColor: "#f44336",
							color: "white",
							border: "none",
							borderRadius: "5px",
							cursor: "pointer",
						}}>
						⏹️ Stop Screen Share
					</button>
				)}
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
				{/* Local Video */}
				<div style={{ border: "2px solid blue", padding: "10px", borderRadius: "8px" }}>
					<h3>📹 Your Camera</h3>
					<video
						ref={localVideoRef}
						muted
						autoPlay
						playsInline
						style={{ width: 320, height: 240, borderRadius: "4px" }}
					/>
				</div>

				{/* Screen Shares */}
				{screenSharePeers.length > 0 ? (
					<div style={{ border: "3px solid green", padding: "15px", borderRadius: "8px", backgroundColor: "#f0fff0" }}>
						<h2>🖥️ Screen Shares ({screenSharePeers.length})</h2>
						<div style={{ display: "flex", flexWrap: "wrap", gap: "15px" }}>
							{screenSharePeers.map((peer) => (
								<div
									key={`screen-${peer.producerId}`}
									style={{
										border: "2px solid #4CAF50",
										padding: "10px",
										borderRadius: "8px",
										backgroundColor: "white",
									}}>
									<h3>🖥️ {peer.clientId}</h3>
									<div style={{ fontSize: "12px", color: "#666", marginBottom: "10px" }}>
										Producer: {peer.producerId}
										<br />
										Consumer: {peer.consumer.id}
										<br />
										Track State: {peer.consumer.track.readyState}
									</div>
									<VideoTile
										consumer={peer.consumer}
										style={{
											width: 800,
											height: 600,
											border: "1px solid #ddd",
											borderRadius: "4px",
										}}
									/>
								</div>
							))}
						</div>
					</div>
				) : (
					<div
						style={{
							padding: "40px",
							backgroundColor: "#f9f9f9",
							borderRadius: "8px",
							textAlign: "center",
							border: "2px dashed #ccc",
						}}>
						<h3>🖥️ No Screen Shares</h3>
						<p>Screen shares will appear here when someone starts sharing.</p>
					</div>
				)}

				{/* Regular Video Peers */}
				{videoPeers.length > 0 && (
					<div style={{ border: "2px solid #2196F3", padding: "15px", borderRadius: "8px" }}>
						<h3>👥 Participants ({videoPeers.length})</h3>
						<div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
							{videoPeers.map((peer) => (
								<div
									key={`video-${peer.producerId}`}
									style={{
										border: "1px solid #ccc",
										padding: "10px",
										borderRadius: "8px",
										backgroundColor: "white",
									}}>
									<h4>👤 {peer.clientId}</h4>
									<div style={{ fontSize: "11px", color: "#666", marginBottom: "5px" }}>
										Track: {peer.consumer.track.readyState}
									</div>
									<VideoTile
										consumer={peer.consumer}
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
			</div>
		</div>
	);
};

export default App;
