// src/socket.ts
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export const connectSocket = () => {
	if (!socket) {
		socket = io("http://localhost:3000", {
			transports: ["websocket"],

			autoConnect: true,
		});

		socket.on("connect", () => {
			console.log("Connected to server");
		});

		socket.on("disconnect", () => {
			console.log("Disconnected from server");
		});

		socket.on("error", (error: any) => {
			console.error("Socket error:", error);
		});
	}

	return socket;
};

export const getSocket = () => socket;
