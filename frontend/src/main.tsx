import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import SocketComponent from "./socket/components/Socket.tsx";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<SocketComponent />
		<App />
	</StrictMode>
);
