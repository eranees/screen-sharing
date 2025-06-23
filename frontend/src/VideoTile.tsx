import React, { useEffect, useRef } from "react";

interface Consumer {
	id: string;
	kind: "audio" | "video";
	track: MediaStreamTrack;
	close: () => void;
}

interface Props {
	consumer: Consumer;
	style?: React.CSSProperties;
	label?: string;
}

const VideoTile: React.FC<Props> = ({ consumer, style, label }) => {
	console.log("consumer", consumer);
	const videoRef = useRef<HTMLVideoElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const streamRef = useRef<MediaStream | null>(null);

	useEffect(() => {
		const videoEl = videoRef.current;
		const audioEl = audioRef.current;

		if (!consumer.track) {
			console.error("Consumer has no track:", consumer);
			return;
		}

		console.log(`Setting up ${consumer.kind} track:`, {
			trackId: consumer.track.id,
			trackLabel: consumer.track.label,
			trackKind: consumer.track.kind,
			trackReadyState: consumer.track.readyState,
			trackEnabled: consumer.track.enabled,
			trackMuted: consumer.track.muted,
		});

		// Check if track is active
		if (consumer.track.readyState === "ended") {
			console.error("Track is already ended:", consumer.track);
			return;
		}

		// Create new stream with the consumer track
		const stream = new MediaStream([consumer.track]);
		streamRef.current = stream;

		// Set up track event listeners
		consumer.track.addEventListener("ended", () => {
			console.log(`Track ${consumer.track.id} ended`);
		});

		consumer.track.addEventListener("mute", () => {
			console.log(`Track ${consumer.track.id} muted`);
		});

		consumer.track.addEventListener("unmute", () => {
			console.log(`Track ${consumer.track.id} unmuted`);
		});

		if (consumer.kind === "video" && videoEl) {
			videoEl.srcObject = stream;

			// Add event listeners for debugging
			videoEl.addEventListener("loadstart", () => console.log("Video loadstart"));
			videoEl.addEventListener("loadedmetadata", () => {
				console.log("Video metadata loaded:", {
					videoWidth: videoEl.videoWidth,
					videoHeight: videoEl.videoHeight,
					duration: videoEl.duration,
				});
			});
			videoEl.addEventListener("canplay", () => console.log("Video can play"));
			videoEl.addEventListener("playing", () => console.log("Video playing"));
			videoEl.addEventListener("error", (e) => console.error("Video error:", e));

			// Force play
			const playPromise = videoEl.play();
			if (playPromise !== undefined) {
				playPromise
					.then(() => {
						console.log("Video play started successfully");
					})
					.catch((error) => {
						console.error("Video play error:", error);
						// Try to play again after a short delay
						setTimeout(() => {
							videoEl.play().catch(console.error);
						}, 100);
					});
			}
		} else if (consumer.kind === "audio" && audioEl) {
			audioEl.srcObject = stream;
			audioEl.play().catch((error) => {
				console.error("Audio play error:", error);
			});
		}

		// Cleanup function
		return () => {
			console.log(`Cleaning up ${consumer.kind} track:`, consumer.track.id);

			if (videoEl) {
				videoEl.pause();
				videoEl.srcObject = null;
			}
			if (audioEl) {
				audioEl.pause();
				audioEl.srcObject = null;
			}

			// Don't stop the track here - let the consumer handle it
			// The track might be used by other components

			if (streamRef.current) {
				streamRef.current = null;
			}
		};
	}, [consumer.track, consumer.kind, consumer.id]);

	if (consumer.kind === "audio") {
		return (
			<div>
				<audio
					ref={audioRef}
					autoPlay
					playsInline
					controls={false}
					style={{ display: "none" }} // Hide audio element
				/>
				{label && <p style={{ textAlign: "center" }}>{label}</p>}
				<div style={{ padding: "10px", textAlign: "center", backgroundColor: "#f0f0f0" }}>🎵 Audio Stream Active</div>
			</div>
		);
	}

	return (
		<div>
			<video
				ref={videoRef}
				autoPlay
				playsInline
				muted={false}
				controls={false}
				style={{
					width: "100%",
					height: "auto",
					maxWidth: "100%",
					backgroundColor: "#000",
					...style,
				}}
			/>
			{label && <p style={{ textAlign: "center", margin: "5px 0" }}>{label}</p>}
		</div>
	);
};

export default VideoTile;
