import { useEffect } from "react";
import { connectSocket } from "../socket";

const SocketComponent = () => {
	useEffect(() => {
		connectSocket();
	}, []);

	return null;
};

export default SocketComponent;
