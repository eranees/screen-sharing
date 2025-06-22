// VideoTile.tsx
import React, { useEffect, useRef } from "react";

interface Props {
	stream: MediaStream;
	label?: string;
}

const VideoTile: React.FC<Props> = ({ stream, label }) => {
	const ref = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		if (ref.current && stream) {
			ref.current.srcObject = stream;
		}
	}, [stream]);

	return (
		<div>
			<video ref={ref} autoPlay playsInline muted={label === "You"} style={{ width: 300 }} />
			{label && <p>{label}</p>}
		</div>
	);
};

export default VideoTile;
