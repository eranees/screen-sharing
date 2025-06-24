import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { useSocket } from "../context/useSocket";

export const VideoCall = () => {
	const { socket } = useSocket();

	const localVideo = useRef<HTMLVideoElement>(null);
	const screenShareVideo = useRef<HTMLVideoElement>(null);
	const remoteContainer = useRef<HTMLDivElement>(null);

	const [device, setDevice] = useState<mediasoupClient.types.Device>();
	const [recvTransport, setRecvTransport] = useState<any>();
	const [sendTransport, setSendTransport] = useState<any>();
	const [isConnected, setIsConnected] = useState(false);
	const [consumers, setConsumers] = useState<Map<string, any>>(new Map());
	const [debugLog, setDebugLog] = useState<string[]>([]);

	// Screen sharing state
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [screenShareProducer, setScreenShareProducer] = useState<any>(null);
	const [screenShareStream, setScreenShareStream] = useState<MediaStream | null>(null);
	const [remoteScreenShares, setRemoteScreenShares] = useState<Map<string, HTMLVideoElement>>(new Map());

	const ROOM_ID = "room-1";

	const addDebugLog = (message: string) => {
		console.log(message);
		setDebugLog((prev) => [...prev.slice(-10), `${new Date().toLocaleTimeString()}: ${message}`]);
	};

	const startScreenShare = async () => {
		try {
			if (!sendTransport) {
				addDebugLog("Send transport not available for screen sharing");
				return;
			}

			addDebugLog("Starting screen share...");

			// Get screen capture stream
			const screenStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					width: { ideal: 1920 },
					height: { ideal: 1080 },
					frameRate: { ideal: 30 },
				},
				audio: true, // Include system audio if available
			});

			setScreenShareStream(screenStream);

			// Clone the stream for local display to avoid conflicts
			const localDisplayStream = screenStream.clone();

			// Display local screen share
			if (screenShareVideo.current) {
				screenShareVideo.current.srcObject = localDisplayStream;
				screenShareVideo.current.muted = true; // Prevent echo

				// Wait for metadata to load then play
				screenShareVideo.current.addEventListener(
					"loadedmetadata",
					async () => {
						try {
							await screenShareVideo.current?.play();
							addDebugLog("Local screen share video started playing");
						} catch (playError) {
							addDebugLog(`Error playing local screen share video: ${playError}`);
						}
					},
					{ once: true }
				);
			}

			// Create screen share producer using original stream
			const videoTrack = screenStream.getVideoTracks()[0];
			const producer = await sendTransport.produce({
				track: videoTrack,
				appData: { mediaType: "screen" },
			});

			setScreenShareProducer(producer);
			setIsScreenSharing(true);
			addDebugLog(`Screen share producer created: ${producer.id}`);

			// Listen for when user stops sharing via browser UI
			videoTrack.addEventListener("ended", () => {
				addDebugLog("Screen share ended by user");
				stopScreenShare();
			});

			// Also listen for the cloned stream track ending
			const clonedTrack = localDisplayStream.getVideoTracks()[0];
			clonedTrack.addEventListener("ended", () => {
				addDebugLog("Cloned screen share track ended");
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			addDebugLog(`Error starting screen share: ${errorMsg}`);
			console.error("Error starting screen share:", error);
		}
	};

	const stopScreenShare = async () => {
		try {
			addDebugLog("Stopping screen share...");

			if (screenShareProducer) {
				screenShareProducer.close();
				setScreenShareProducer(null);
			}

			// Stop the local display stream
			if (screenShareVideo.current?.srcObject) {
				const localStream = screenShareVideo.current.srcObject as MediaStream;
				localStream.getTracks().forEach((track) => {
					track.stop();
					addDebugLog(`Local display track stopped: ${track.kind}`);
				});
				screenShareVideo.current.srcObject = null;
			}

			// Stop the original screen share stream
			if (screenShareStream) {
				screenShareStream.getTracks().forEach((track) => {
					track.stop();
					addDebugLog(`Screen share track stopped: ${track.kind}`);
				});
				setScreenShareStream(null);
			}

			// Notify server to stop screen share
			if (socket) {
				const response = await socket.emitWithAck("stop-screen-share", {});
				if (response.success) {
					addDebugLog("Screen share stopped successfully");
				} else {
					addDebugLog(`Failed to stop screen share: ${response.error}`);
				}
			}

			setIsScreenSharing(false);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			addDebugLog(`Error stopping screen share: ${errorMsg}`);
			console.error("Error stopping screen share:", error);
		}
	};

	const consumeRemoteScreenShare = async (producerId: string, socketId: string) => {
		try {
			if (!socket) return;

			if (!device || !recvTransport) {
				addDebugLog("Device or receive transport not available for screen share consumption");
				return;
			}

			addDebugLog(`Consuming remote screen share: ${producerId} from ${socketId}`);

			const response = await socket.emitWithAck("consume", {
				producerId,
				rtpCapabilities: device.rtpCapabilities,
			});

			if (!response.success) {
				addDebugLog(`Failed to consume screen share: ${response.error}`);
				return;
			}

			const consumer = await recvTransport.consume({
				id: response.id,
				producerId: response.producerId,
				kind: response.kind,
				rtpParameters: response.rtpParameters,
			});

			// Store consumer for cleanup
			setConsumers((prev) => new Map(prev.set(response.id, consumer)));

			const stream = new MediaStream([consumer.track]);

			const video = document.createElement("video");
			video.srcObject = stream;
			video.autoplay = true;
			video.playsInline = true;
			video.muted = true;
			video.style.width = "600px";
			video.style.height = "400px";
			video.style.margin = "10px";
			video.style.border = "3px solid #ffc107";
			video.style.borderRadius = "8px";
			video.style.backgroundColor = "#000";
			video.id = `screen-share-${socketId}`;

			// Add label for screen share
			const label = document.createElement("div");
			label.textContent = `Screen Share - User ${socketId.substring(0, 8)}`;
			label.style.position = "absolute";
			label.style.top = "10px";
			label.style.left = "10px";
			label.style.backgroundColor = "rgba(255, 193, 7, 0.9)";
			label.style.color = "#000";
			label.style.padding = "5px 10px";
			label.style.borderRadius = "4px";
			label.style.fontSize = "12px";
			label.style.fontWeight = "bold";

			const container = document.createElement("div");
			container.style.position = "relative";
			container.style.display = "inline-block";
			container.appendChild(video);
			container.appendChild(label);

			// Resume consumer if paused
			if (consumer.paused) {
				await consumer.resume();
				addDebugLog(`Screen share consumer ${response.id} resumed`);
			}

			remoteContainer.current?.appendChild(container);

			setRemoteScreenShares((prev) => new Map(prev.set(socketId, video)));
			addDebugLog(`Remote screen share displayed for user: ${socketId}`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			addDebugLog(`Error consuming remote screen share: ${errorMsg}`);
			console.error("Error consuming remote screen share:", error);
		}
	};

	const removeRemoteScreenShare = (socketId: string, producerId: string) => {
		addDebugLog(`Removing remote screen share for user: ${socketId}`);

		// Find and remove the screen share video element
		const screenShareElement = document.getElementById(`screen-share-${socketId}`);
		if (screenShareElement) {
			screenShareElement.parentElement?.remove(); // Remove the container div
		}

		setRemoteScreenShares((prev) => {
			const newMap = new Map(prev);
			newMap.delete(socketId);
			return newMap;
		});

		// Close the consumer
		consumers.forEach((consumer, consumerId) => {
			if (consumer.producerId === producerId) {
				consumer.close();
				setConsumers((prev) => {
					const newMap = new Map(prev);
					newMap.delete(consumerId);
					return newMap;
				});
				addDebugLog(`Screen share consumer closed: ${consumerId}`);
			}
		});
	};

	useEffect(() => {
		if (!socket) return;

		// Capture refs early to avoid stale closures
		const localVideoRef = localVideo.current;
		const remoteContainerRef = remoteContainer.current;

		const consumeRemoteProducer = async (
			producerId: string,
			device: mediasoupClient.types.Device,
			recvTransport: any,
			mediaType?: "camera" | "screen"
		) => {
			try {
				addDebugLog(`Attempting to consume producer: ${producerId} (${mediaType || "unknown"})`);

				const response = await socket.emitWithAck("consume", {
					producerId,
					rtpCapabilities: device.rtpCapabilities,
				});

				if (!response.success) {
					addDebugLog(`Failed to consume: ${response.error}`);
					return;
				}

				addDebugLog(
					`Consume response received: ${JSON.stringify({
						id: response.id,
						kind: response.kind,
						producerId: response.producerId,
						mediaType: response.mediaType,
					})}`
				);

				const consumer = await recvTransport.consume({
					id: response.id,
					producerId: response.producerId,
					kind: response.kind,
					rtpParameters: response.rtpParameters,
				});

				// Store consumer for cleanup
				setConsumers((prev) => new Map(prev.set(response.id, consumer)));

				const stream = new MediaStream([consumer.track]);
				addDebugLog(`Created MediaStream with track: ${consumer.track.kind}`);

				const video = document.createElement("video");
				video.srcObject = stream;
				video.autoplay = true;
				video.playsInline = true;
				video.muted = consumer.kind === "audio" ? false : true;

				// Style based on media type
				if (response.mediaType === "screen") {
					video.style.width = "600px";
					video.style.height = "400px";
					video.style.border = "3px solid #ffc107";
				} else {
					video.style.width = "300px";
					video.style.height = "200px";
					video.style.border = "2px solid #28a745";
				}

				video.style.margin = "5px";
				video.style.borderRadius = "8px";
				video.id = `remote-video-${response.id}`;

				// Resume consumer if paused
				if (consumer.paused) {
					await consumer.resume();
					addDebugLog(`Consumer ${response.id} resumed`);
				}

				remoteContainerRef?.appendChild(video);
				addDebugLog(`Remote video element added for producer: ${producerId}`);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : "Unknown error";
				addDebugLog(`Error consuming remote producer: ${errorMsg}`);
				console.error("Error consuming remote producer:", error);
			}
		};

		const startCall = async () => {
			try {
				addDebugLog("Starting video call...");

				// Get user media
				const stream = await navigator.mediaDevices.getUserMedia({
					video: { width: 640, height: 480 },
					audio: true,
				});

				if (localVideoRef) {
					localVideoRef.srcObject = stream;
				}
				addDebugLog("Local media stream obtained");

				// Get RTP capabilities
				const rtpResponse = await socket.emitWithAck("get-rtp-capabilities");
				if (!rtpResponse.success) {
					throw new Error("Failed to get RTP capabilities: " + rtpResponse.error);
				}
				addDebugLog("RTP capabilities received");

				// Create device
				const dev = new mediasoupClient.Device();
				await dev.load({ routerRtpCapabilities: rtpResponse.rtpCapabilities });
				setDevice(dev);
				addDebugLog("MediaSoup device created and loaded");

				// Create send transport
				const sendTransportResponse = await socket.emitWithAck("create-transport", {
					direction: "send",
				});

				if (!sendTransportResponse.success) {
					throw new Error("Failed to create send transport: " + sendTransportResponse.error);
				}
				addDebugLog("Send transport created");

				const sendTransportObj = dev.createSendTransport(sendTransportResponse);
				setSendTransport(sendTransportObj);

				sendTransportObj.on("connect", async ({ dtlsParameters }, callback) => {
					try {
						addDebugLog("Connecting send transport...");
						const response = await socket.emitWithAck("connect-transport", {
							transportId: sendTransportObj.id,
							dtlsParameters,
						});

						if (response.success) {
							addDebugLog("Send transport connected");
							callback();
						} else {
							const errorMsg = typeof response.error === "string" ? response.error : "Unknown error";
							addDebugLog(`Send transport connection failed: ${errorMsg}`);
							throw new Error(errorMsg);
						}
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : "Unknown error";
						addDebugLog(`Send transport connection error: ${errorMsg}`);
						throw error instanceof Error ? error : new Error(errorMsg);
					}
				});

				sendTransportObj.on("produce", async ({ kind, rtpParameters, appData }, callback) => {
					try {
						const mediaType = appData?.mediaType || "camera";
						addDebugLog(`Producing ${kind} track (${mediaType})...`);

						const response = await socket.emitWithAck("produce", {
							transportId: sendTransportObj.id,
							kind,
							rtpParameters,
							appData,
						});

						if (response.success) {
							addDebugLog(`${kind} producer created with ID: ${response.id} (${mediaType})`);
							callback({ id: response.id });
						} else {
							const errorMsg = typeof response.error === "string" ? response.error : "Unknown error";
							addDebugLog(`Failed to create ${kind} producer: ${errorMsg}`);
							throw new Error(errorMsg);
						}
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : "Unknown error";
						addDebugLog(`Producer creation error: ${errorMsg}`);
						throw error instanceof Error ? error : new Error(errorMsg);
					}
				});

				// Create receive transport BEFORE joining room
				const recvTransportResponse = await socket.emitWithAck("create-transport", {
					direction: "recv",
				});

				if (!recvTransportResponse.success) {
					throw new Error("Failed to create receive transport: " + recvTransportResponse.error);
				}
				addDebugLog("Receive transport created");

				const recv = dev.createRecvTransport(recvTransportResponse);
				setRecvTransport(recv);

				recv.on("connect", async ({ dtlsParameters }, callback) => {
					try {
						addDebugLog("Connecting receive transport...");
						const response = await socket.emitWithAck("connect-transport", {
							transportId: recv.id,
							dtlsParameters,
						});

						if (response.success) {
							addDebugLog("Receive transport connected");
							callback();
						} else {
							const errorMsg = typeof response.error === "string" ? response.error : "Unknown error";
							addDebugLog(`Receive transport connection failed: ${errorMsg}`);
							throw new Error(errorMsg);
						}
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : "Unknown error";
						addDebugLog(`Receive transport connection error: ${errorMsg}`);
						throw error instanceof Error ? error : new Error(errorMsg);
					}
				});

				// Join room AFTER transports are ready
				const joinResponse = await socket.emitWithAck("join-room", { roomId: ROOM_ID });

				if (!joinResponse.success) {
					throw new Error("Failed to join room: " + joinResponse.error);
				}
				addDebugLog(`Joined room. Found ${joinResponse.producers?.length || 0} existing producers`);

				// Produce audio and video tracks AFTER joining room
				const producers = [];
				for (const track of stream.getTracks()) {
					const producer = await sendTransportObj.produce({ track });
					producers.push(producer);
					addDebugLog(`Local ${track.kind} producer created: ${producer.id}`);
				}

				// Consume existing producers
				if (joinResponse.producers && joinResponse.producers.length > 0) {
					for (const { producerId, socketId, mediaType } of joinResponse.producers) {
						addDebugLog(`Consuming existing producer: ${producerId} from socket: ${socketId} (${mediaType})`);
						await consumeRemoteProducer(producerId, dev, recv, mediaType);
					}
				} else {
					addDebugLog("No existing producers to consume");
				}

				setIsConnected(true);
				addDebugLog("Successfully connected to video call");
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : "Unknown error";
				addDebugLog(`Error starting video call: ${errorMsg}`);
				console.error("Error starting video call:", error);
				setIsConnected(false);
			}
		};

		startCall();

		// Listen for new producers
		const handleNewProducer = async ({
			producerId,
			socketId,
			mediaType,
		}: {
			producerId: string;
			socketId: string;
			mediaType?: "camera" | "screen";
		}) => {
			addDebugLog(`New producer detected: ${producerId} from socket: ${socketId} (${mediaType})`);

			if (device && recvTransport && socketId !== socket.id) {
				await consumeRemoteProducer(producerId, device, recvTransport, mediaType);
			} else {
				addDebugLog(`Skipping own producer or missing transport/device`);
			}
		};

		// Listen for screen share events
		const handleScreenShareStarted = async ({ producerId, socketId }: { producerId: string; socketId: string }) => {
			addDebugLog(`Screen share started: ${producerId} from socket: ${socketId}`);

			if (device && recvTransport && socketId !== socket.id) {
				await consumeRemoteScreenShare(producerId, socketId);
			}
		};

		const handleScreenShareStopped = ({ producerId, socketId }: { producerId: string; socketId: string }) => {
			addDebugLog(`Screen share stopped: ${producerId} from socket: ${socketId}`);
			removeRemoteScreenShare(socketId, producerId);
		};

		socket.on("new-producer", handleNewProducer);
		socket.on("screen-share-started", handleScreenShareStarted);
		socket.on("screen-share-stopped", handleScreenShareStopped);

		// Cleanup function
		return () => {
			addDebugLog("Cleaning up video call...");
			socket.off("new-producer", handleNewProducer);
			socket.off("screen-share-started", handleScreenShareStarted);
			socket.off("screen-share-stopped", handleScreenShareStopped);

			// Close consumers
			consumers.forEach((consumer, id) => {
				consumer.close();
				addDebugLog(`Consumer ${id} closed`);
			});
			setConsumers(new Map());

			// Close transports
			if (sendTransport) {
				sendTransport.close();
				addDebugLog("Send transport closed");
			}
			if (recvTransport) {
				recvTransport.close();
				addDebugLog("Receive transport closed");
			}

			// Stop local stream using captured ref
			if (localVideoRef?.srcObject) {
				const stream = localVideoRef.srcObject as MediaStream;
				stream.getTracks().forEach((track) => {
					track.stop();
					addDebugLog(`Local ${track.kind} track stopped`);
				});
			}

			// Stop screen share
			if (isScreenSharing) {
				stopScreenShare();
			}

			// Clear remote videos using captured ref
			if (remoteContainerRef) {
				remoteContainerRef.innerHTML = "";
				addDebugLog("Remote video container cleared");
			}
		};
	}, [socket]);

	return (
		<div style={{ padding: "20px" }}>
			<div style={{ marginBottom: "20px" }}>
				<h2>Video Call - Room: {ROOM_ID}</h2>
				<div
					style={{
						padding: "10px",
						backgroundColor: isConnected ? "#d4edda" : "#f8d7da",
						border: `1px solid ${isConnected ? "#c3e6cb" : "#f5c6cb"}`,
						borderRadius: "4px",
						marginBottom: "20px",
					}}>
					Status: {isConnected ? "Connected" : "Connecting..."}
				</div>

				{/* Screen Share Controls */}
				<div style={{ marginBottom: "20px" }}>
					<button
						onClick={isScreenSharing ? stopScreenShare : startScreenShare}
						disabled={!isConnected}
						style={{
							padding: "10px 20px",
							backgroundColor: isScreenSharing ? "#dc3545" : "#007bff",
							color: "white",
							border: "none",
							borderRadius: "4px",
							cursor: isConnected ? "pointer" : "not-allowed",
							fontSize: "16px",
							fontWeight: "bold",
						}}>
						{isScreenSharing ? "Stop Screen Share" : "Start Screen Share"}
					</button>
					{isScreenSharing && (
						<span style={{ marginLeft: "10px", color: "#28a745", fontWeight: "bold" }}>🟢 Screen sharing active</span>
					)}
				</div>
			</div>

			<div style={{ display: "flex", gap: "40px", flexWrap: "wrap" }}>
				<div>
					<h3>Local Video</h3>
					<video
						ref={localVideo}
						autoPlay
						muted
						playsInline
						style={{
							width: "300px",
							height: "200px",
							border: "2px solid #007bff",
							borderRadius: "8px",
						}}
					/>
				</div>

				{/* Local Screen Share */}
				{isScreenSharing && (
					<div>
						<h3>Your Screen Share</h3>
						<video
							ref={screenShareVideo}
							autoPlay
							muted
							playsInline
							style={{
								width: "300px",
								height: "300px",
								border: "3px solid #ffc107",
								borderRadius: "8px",
								backgroundColor: "#000",
							}}
						/>
					</div>
				)}

				<div>
					<h3>Remote Videos ({consumers.size - 1})</h3>
					<div
						ref={remoteContainer}
						style={{
							display: "flex",
							flexWrap: "wrap",
							gap: "10px",
							minHeight: "200px",
							padding: "10px",
							border: "1px dashed #ccc",
							borderRadius: "8px",
						}}
					/>
				</div>
			</div>

			{/* Debug Panel */}
			<div style={{ marginTop: "20px" }}>
				<h3>Debug Log</h3>
				<div
					style={{
						height: "200px",
						overflowY: "auto",
						backgroundColor: "#f8f9fa",
						border: "1px solid #dee2e6",
						borderRadius: "4px",
						padding: "10px",
						fontSize: "12px",
						fontFamily: "monospace",
					}}>
					{debugLog.map((log, index) => (
						<div
							key={index}
							style={{
								color:
									log.includes("Error") || log.includes("Failed")
										? "#dc3545"
										: log.includes("Screen share")
										? "#ffc107"
										: "#000",
							}}>
							{log}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
