import { useEffect, useRef, useState, useCallback } from "react";
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
	const [showDebug, setShowDebug] = useState(true);

	// Screen sharing state
	const [isScreenSharing, setIsScreenSharing] = useState(false);
	const [screenShareProducer, setScreenShareProducer] = useState<any>(null);
	const [screenShareStream, setScreenShareStream] = useState<MediaStream | null>(null);
	const [remoteScreenShares, setRemoteScreenShares] = useState<Map<string, HTMLVideoElement>>(new Map());
	const [pendingProducers, setPendingProducers] = useState<
		{ producerId: string; socketId: string; mediaType: "camera" | "screen" }[]
	>([]);

	const ROOM_ID = "room-1";

	console.log(remoteScreenShares);

	const addDebugLog = useCallback((message: string) => {
		console.log(message);
		setDebugLog((prev) => [...prev.slice(-10), `${new Date().toLocaleTimeString()}: ${message}`]);
	}, []);

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

			if (localDisplayStream.getVideoTracks().length === 0) {
				addDebugLog("Cloned screen share stream has no video tracks");
				return;
			}

			if (screenShareVideo.current) {
				screenShareVideo.current.srcObject = localDisplayStream;
				screenShareVideo.current.muted = true;
				screenShareVideo.current.title = "Local screen share";

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

	// Unified function to consume any remote producer
	const consumeRemoteProducer = useCallback(
		async (producerId: string, socketId: string, mediaType: "camera" | "screen" = "camera") => {
			try {
				if (!socket) {
					addDebugLog("Missing socket, device, or receive transport for consumption");
					return;
				}

				if (!device || !recvTransport) {
					addDebugLog(`Queuing producer ${producerId} - device/transport not ready`);
					setPendingProducers((prev) => [...prev, { producerId, socketId, mediaType }]);
					return;
				}

				if (socketId === socket.id) {
					addDebugLog("Skipping own producer");
					return;
				}

				addDebugLog(`Consuming ${mediaType} producer: ${producerId} from ${socketId}`);

				const response = await socket.emitWithAck("consume", {
					producerId,
					rtpCapabilities: device.rtpCapabilities,
				});

				if (!response.success) {
					addDebugLog(`Failed to consume ${mediaType}: ${response.error}`);
					return;
				}

				const consumer = await recvTransport.consume({
					id: response.id,
					producerId: response.producerId,
					kind: response.kind,
					rtpParameters: response.rtpParameters,
				});

				// Track check BEFORE appending to DOM
				const track = consumer.track;
				if (consumer.kind !== "video" || !track || track.readyState === "ended") {
					addDebugLog(`❌ Skipping invalid video consumer for ${mediaType}`);
					consumer.close();
					return;
				}

				const stream = new MediaStream([track]);

				if (stream.getVideoTracks().length === 0) {
					addDebugLog(`❌ No usable video track for ${mediaType}, skipping`);
					consumer.close();
					return;
				}

				// Build a unique ID based on media type and socket ID
				const videoId = `${mediaType}-video-${socketId}`;

				// Remove existing video if it exists
				const existingVideo = document.getElementById(videoId);
				if (existingVideo) {
					existingVideo.parentElement?.remove();
					addDebugLog(`Removed existing ${mediaType} video for ${socketId}`);
				}

				// Create video element
				const video = document.createElement("video");
				video.srcObject = stream;
				video.autoplay = true;
				video.playsInline = true;
				video.muted = true;
				video.style.objectFit = "contain";
				video.style.margin = "5px";
				video.style.borderRadius = "8px";
				video.style.backgroundColor = "#000";
				video.dataset.mediaType = mediaType;
				video.id = videoId;

				// Create container with label
				const container = document.createElement("div");
				container.style.position = "relative";
				container.style.display = "inline-block";

				// Create label
				const label = document.createElement("div");
				label.style.position = "absolute";
				label.style.top = "10px";
				label.style.left = "10px";
				label.style.padding = "5px 10px";
				label.style.borderRadius = "4px";
				label.style.fontSize = "12px";
				label.style.fontWeight = "bold";
				label.style.zIndex = "10";

				// Style by media type
				if (mediaType === "screen") {
					video.style.border = "3px solid #ffc107"; // yellow
					video.style.width = "600px";
					video.style.height = "400px";
					label.textContent = `Screen Share - ${socketId.substring(0, 8)}`;
					label.style.backgroundColor = "rgba(255, 193, 7, 0.9)";
					label.style.color = "#000";
				} else {
					video.style.border = "2px solid #28a745"; // green
					video.style.width = "300px";
					video.style.height = "200px";
					label.textContent = `Camera - ${socketId.substring(0, 8)}`;
					label.style.backgroundColor = "rgba(40, 167, 69, 0.9)";
					label.style.color = "#fff";
				}

				container.appendChild(video);
				container.appendChild(label);

				// Store consumer for cleanup
				setConsumers((prev) => new Map(prev.set(response.id, consumer)));

				// Resume consumer if paused
				if (consumer.paused) {
					await consumer.resume();
					addDebugLog(`${mediaType} consumer ${response.id} resumed`);
				}

				// Add to remote container
				if (remoteContainer.current) {
					remoteContainer.current.appendChild(container);
					addDebugLog(`${mediaType} video displayed for user: ${socketId}`);
				}

				// Update screen share state if needed
				if (mediaType === "screen") {
					setRemoteScreenShares((prev) => new Map(prev.set(socketId, video)));
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : "Unknown error";
				addDebugLog(`Error consuming ${mediaType} producer: ${errorMsg}`);
				console.error(`Error consuming ${mediaType} producer:`, error);
			}
		},
		[socket, device, recvTransport, addDebugLog]
	);

	const removeRemoteProducer = useCallback(
		(socketId: string, producerId: string, mediaType: "camera" | "screen" = "camera") => {
			addDebugLog(`Removing ${mediaType} for user: ${socketId}`);

			// Find and remove the video element
			const videoElement = document.getElementById(`${mediaType}-video-${socketId}`);
			if (videoElement) {
				videoElement.parentElement?.remove(); // Remove the container div
				addDebugLog(`${mediaType} video element removed for ${socketId}`);
			}

			// Update screen share state if needed
			if (mediaType === "screen") {
				setRemoteScreenShares((prev) => {
					const newMap = new Map(prev);
					newMap.delete(socketId);
					return newMap;
				});
			}

			// Close the consumer
			setConsumers((prev) => {
				const newMap = new Map(prev);
				for (const [consumerId, consumer] of prev.entries()) {
					if (consumer.producerId === producerId) {
						consumer.close();
						newMap.delete(consumerId);
						addDebugLog(`${mediaType} consumer closed: ${consumerId}`);
						break;
					}
				}
				return newMap;
			});
		},
		[addDebugLog]
	);

	useEffect(() => {
		if (device && recvTransport && pendingProducers.length > 0) {
			pendingProducers.forEach(({ producerId, socketId, mediaType }) => {
				consumeRemoteProducer(producerId, socketId, mediaType);
			});
			setPendingProducers([]); // Clear queue
		}
	}, [device, recvTransport, pendingProducers, consumeRemoteProducer]);

	useEffect(() => {
		if (!isScreenSharing || !screenShareStream) return;

		const videoEl = screenShareVideo.current;
		if (!videoEl) {
			console.warn("screenShareVideo not ready yet");
			return;
		}

		videoEl.srcObject = screenShareStream;
		videoEl.muted = true;

		const play = async () => {
			try {
				await videoEl.play();
				addDebugLog("Screen share video started playing");
			} catch (err: any) {
				addDebugLog("Failed to play screen share video: " + err.message);
			}
		};

		videoEl.addEventListener("loadedmetadata", play, { once: true });

		return () => {
			videoEl.removeEventListener("loadedmetadata", play);
		};
	}, [isScreenSharing, screenShareStream]);

	// Set up socket event listeners first, before starting the call
	useEffect(() => {
		if (!socket) return;

		// Listen for new producers (camera/audio)
		const handleNewProducer = async ({
			producerId,
			socketId,
			mediaType,
		}: {
			producerId: string;
			socketId: string;
			mediaType?: "camera" | "screen";
		}) => {
			addDebugLog(`New producer detected: ${producerId} from socket: ${socketId} (${mediaType || "camera"})`);
			await consumeRemoteProducer(producerId, socketId, mediaType || "camera");
		};

		// Listen for screen share events
		const handleScreenShareStarted = async ({ producerId, socketId }: { producerId: string; socketId: string }) => {
			addDebugLog(`Screen share started: ${producerId} from socket: ${socketId}`);
			await consumeRemoteProducer(producerId, socketId, "screen");
		};

		const handleScreenShareStopped = ({ producerId, socketId }: { producerId: string; socketId: string }) => {
			addDebugLog(`Screen share stopped: ${producerId} from socket: ${socketId}`);
			removeRemoteProducer(socketId, producerId, "screen");
		};

		// Set up event listeners
		socket.on("new-producer", handleNewProducer);
		socket.on("screen-share-started", handleScreenShareStarted);
		socket.on("screen-share-stopped", handleScreenShareStopped);

		// Cleanup function
		return () => {
			socket.off("new-producer", handleNewProducer);
			socket.off("screen-share-started", handleScreenShareStarted);
			socket.off("screen-share-stopped", handleScreenShareStopped);
		};
	}, [socket, consumeRemoteProducer, removeRemoteProducer, addDebugLog]);

	// Main call setup effect
	useEffect(() => {
		if (!socket) return;

		const localVideoRef = localVideo.current;
		const remoteContainerRef = remoteContainer.current;

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

				// Create receive transport
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

				// Join room
				const joinResponse = await socket.emitWithAck("join-room", { roomId: ROOM_ID });

				if (!joinResponse.success) {
					throw new Error("Failed to join room: " + joinResponse.error);
				}
				addDebugLog(`Joined room. Found ${joinResponse.producers?.length || 0} existing producers`);

				// Produce audio and video tracks
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
						await consumeRemoteProducer(producerId, socketId, mediaType);
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

		// Cleanup function
		return () => {
			addDebugLog("Cleaning up video call...");

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

			// Stop local stream
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

			// Clear remote videos
			if (remoteContainerRef) {
				remoteContainerRef.innerHTML = "";
				addDebugLog("Remote video container cleared");
			}
		};
	}, [socket]); // Remove dependencies that cause re-runs

	return (
		<div
			style={{
				padding: "24px",
				backgroundColor: "#f5f7fa",
				minHeight: "100vh",

				fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
			}}>
			<div
				style={{
					maxWidth: "1400px",
					margin: "0 auto",
					backgroundColor: "white",
					borderRadius: "16px",
					boxShadow: "0 4px 20px rgba(0, 0, 0, 0.08)",
					overflow: "hidden",
					height: "100vh",
				}}>
				{/* Header */}
				<div
					style={{
						padding: "20px 24px",
						backgroundColor: "#4f46e5",
						color: "white",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}>
					<div>
						<h1 style={{ margin: 0, fontSize: "24px", fontWeight: 600 }}>Video Conference</h1>
						<div style={{ display: "flex", alignItems: "center", marginTop: "4px" }}>
							<div
								style={{
									width: "10px",
									height: "10px",
									borderRadius: "50%",
									backgroundColor: isConnected ? "#10b981" : "#ef4444",
									marginRight: "8px",
								}}
							/>
							<span>{isConnected ? `Connected to Room: ${ROOM_ID}` : "Connecting..."}</span>
						</div>
					</div>

					<div style={{ display: "flex", gap: "12px" }}>
						<button
							onClick={isScreenSharing ? stopScreenShare : startScreenShare}
							disabled={!isConnected}
							style={{
								padding: "8px 16px",
								backgroundColor: isScreenSharing ? "#ef4444" : "#4f46e5",
								color: "white",
								borderRadius: "6px",
								cursor: isConnected ? "pointer" : "not-allowed",
								fontSize: "14px",
								fontWeight: 500,
								display: "flex",
								alignItems: "center",
								gap: "6px",
								border: `1px solid ${isScreenSharing ? "#dc2626" : "#4338ca"}`,
								transition: "all 0.2s",
							}}>
							{isScreenSharing ? (
								<>
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path d="M6 18L18 6M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
									</svg>
									Stop Sharing
								</>
							) : (
								<>
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
										<path
											d="M9 3H5C4.46957 3 3.96086 3.21071 3.58579 3.58579C3.21071 3.96086 3 4.46957 3 5V19C3 19.5304 3.21071 20.0391 3.58579 20.4142C3.96086 20.7893 4.46957 21 5 21H19C19.5304 21 20.0391 20.7893 20.4142 20.4142C20.7893 20.0391 21 19.5304 21 19V15M15 3H21V9M10 14L21 3"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
									Share Screen
								</>
							)}
						</button>

						<button
							onClick={() => setShowDebug(!showDebug)}
							style={{
								padding: "8px 16px",
								backgroundColor: showDebug ? "#6b7280" : "#4f46e5",
								color: "white",
								borderRadius: "6px",
								cursor: "pointer",
								fontSize: "14px",
								fontWeight: 500,
								display: "flex",
								alignItems: "center",
								gap: "6px",
								border: `1px solid ${showDebug ? "#4b5563" : "#4338ca"}`,
								transition: "all 0.2s",
							}}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
								<path
									d="M12 13V15M12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12C21 16.9706 16.9706 21 12 21ZM12 9V10"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
							</svg>
							{showDebug ? "Hide Debug" : "Show Debug"}
						</button>
					</div>
				</div>

				{/* Main Content */}
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "300px 1fr",
						gap: "24px",
						padding: "24px",
					}}>
					{/* Local User Panel */}
					<div
						style={{
							backgroundColor: "#f9fafb",
							borderRadius: "12px",
							padding: "16px",
							boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
							border: "1px solid #e5e7eb",
						}}>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "16px",
							}}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "8px",
									paddingBottom: "12px",
									borderBottom: "1px solid #e5e7eb",
								}}>
								<div
									style={{
										width: "32px",
										height: "32px",
										borderRadius: "50%",
										backgroundColor: "#4f46e5",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										color: "white",
										fontWeight: "bold",
									}}>
									Y
								</div>
								<h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>You</h3>
							</div>

							<video
								ref={localVideo}
								autoPlay
								muted
								playsInline
								style={{
									width: "100%",
									aspectRatio: "16/9",
									borderRadius: "8px",
									backgroundColor: "#e5e7eb",
									objectFit: "cover",
								}}
							/>

							{isScreenSharing && (
								<div
									style={{
										marginTop: "12px",
										paddingTop: "12px",
										borderTop: "1px solid #e5e7eb",
									}}>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											marginBottom: "8px",
										}}>
										<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
											<path
												d="M9 3H5C4.46957 3 3.96086 3.21071 3.58579 3.58579C3.21071 3.96086 3 4.46957 3 5V19C3 19.5304 3.21071 20.0391 3.58579 20.4142C3.96086 20.7893 4.46957 21 5 21H19C19.5304 21 20.0391 20.7893 20.4142 20.4142C20.7893 20.0391 21 19.5304 21 19V15M15 3H21V9M10 14L21 3"
												stroke="#4f46e5"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
										<span style={{ fontSize: "14px", fontWeight: 600, color: "#4f46e5" }}>Sharing Screen</span>
									</div>
									<video
										ref={screenShareVideo}
										autoPlay
										muted
										playsInline
										style={{
											width: "100%",
											aspectRatio: "16/9",
											borderRadius: "8px",
											backgroundColor: "#111827",
											objectFit: "contain",
										}}
									/>
								</div>
							)}
						</div>
					</div>

					{/* Remote Participants */}
					<div>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								marginBottom: "16px",
							}}>
							<h3 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Participants</h3>
							<div
								style={{
									backgroundColor: "#e0e7ff",
									color: "#4f46e5",
									padding: "4px 8px",
									borderRadius: "12px",
									fontSize: "12px",
									fontWeight: 600,
								}}>
								{consumers.size} {consumers.size === 1 ? "participant" : "participants"}
							</div>
						</div>

						<div
							ref={remoteContainer}
							style={{
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
								gap: "16px",
								minHeight: "200px",
							}}
						/>
					</div>
				</div>

				{/* Debug Panel */}
				{showDebug && (
					<div
						style={{
							padding: "16px 24px",
							marginTop: "20px",
							borderTop: "1px solid #e5e7eb",
							backgroundColor: "#f9fafb",
						}}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								marginBottom: "12px",
							}}>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
								<path
									d="M12 13V15M12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12C21 16.9706 16.9706 21 12 21ZM12 9V10"
									stroke="#4f46e5"
									strokeWidth="2"
									strokeLinecap="round"
								/>
							</svg>
							<h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#4f46e5" }}>Debug Log</h3>
						</div>
						<div
							style={{
								height: "300px",
								overflowY: "auto",
								backgroundColor: "#111827",
								borderRadius: "8px",
								padding: "12px",
								fontSize: "12px",
								fontFamily: "monospace",
								color: "#e5e7eb",
							}}>
							{debugLog.length === 0 ? (
								<div style={{ color: "#9ca3af" }}>No debug messages yet...</div>
							) : (
								debugLog.map((log, index) => (
									<div
										key={index}
										style={{
											color:
												log.includes("Error") || log.includes("Failed")
													? "#f87171"
													: log.includes("Screen share")
													? "#fbbf24"
													: "#e5e7eb",
											marginBottom: "4px",
											lineHeight: "1.5",
										}}>
										{log}
									</div>
								))
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
};
