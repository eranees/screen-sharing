import "./App.css";
import { VideoCall } from "./components/VideoCall";
import { useSocket } from "./context/useSocket";

function App() {
	const socket = useSocket();
	console.log(socket);
	return <VideoCall />;
}

export default App;
