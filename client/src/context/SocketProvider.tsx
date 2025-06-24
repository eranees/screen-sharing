import React, { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { SocketContext } from "./SocketContext";

const SOCKET_SERVER_URL = "http://localhost:3000";

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [isConnected, setIsConnected] = useState(false);
	const socketRef = useRef<Socket | null>(null);

	useEffect(() => {
		const socket = io(SOCKET_SERVER_URL, {
			transports: ["websocket"],
		});

		socketRef.current = socket;

		socket.on("connect", () => {
			console.log("✅ Connected");
			setIsConnected(true);
		});

		socket.on("disconnect", () => {
			console.log("❌ Disconnected");
			setIsConnected(false);
		});

		return () => {
			socket.disconnect();
		};
	}, []);

	return <SocketContext.Provider value={{ socket: socketRef.current, isConnected }}>{children}</SocketContext.Provider>;
};
