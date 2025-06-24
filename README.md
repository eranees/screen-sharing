# MediaSoup Video Call with Screen Share

### A real-time video calling application with screen sharing capabilities built using MediaSoup, NestJS, and React. This project demonstrates WebRTC-based peer-to-peer communication with advanced features like screen sharing, multiple video streams, and room-based video conferencing.

# 🚀 Features

### Real-time Video Calling: High-quality video and audio communication

Screen Sharing: Share your screen with other participants in the call
Room-based Communication: Join specific rooms for group video calls
Multiple Stream Support: Handle multiple video streams simultaneously
WebRTC Transport: Efficient peer-to-peer communication using MediaSoup
Responsive UI: Clean and intuitive React-based user interface
Debug Console: Real-time logging for troubleshooting

# 🏗️ Architecture

Backend (NestJS + MediaSoup)

MediaSoup Worker: Handles WebRTC transport and media routing
Socket.IO Gateway: Manages real-time communication between clients
Room Management: Handles user joining/leaving rooms
Producer/Consumer Model: Manages media streams efficiently

Frontend (React + MediaSoup Client)

MediaSoup Client: Handles WebRTC transport on the client side
React Hooks: Manages component state and lifecycle
Socket.IO Client: Real-time communication with the backend
Media Stream Management: Handles camera, microphone, and screen capture

# 📋 Prerequisites

Node.js (v16 or higher)
npm or yarn
Modern web browser with WebRTC support

# 🛠️ Installation

## Backend Setup

Clone the repository and navigate to the backend directory:

git clone (https://github.com/eranees/screen-sharing.git)

```
cd screen-sharing/server

Install dependencies:

npm install

Install MediaSoup dependencies:

npm install mediasoup
npm install @nestjs/websockets
npm install @nestjs/platform-socket.io

Start the backend server:

npm run start:dev

```

## Frontend Setup

Navigate to the frontend directory:

```
cd frontend

Install dependencies:

npm install

Install MediaSoup client:

npm install mediasoup-client
npm install socket.io-client

Start the React development server:

npm start
```

# 🔧 Configuration

MediaSoup Configuration
The MediaSoup worker is configured with the following codecs:

Audio: Opus (48kHz, 2 channels)
Video: VP8, VP9, H.264 with various profiles

Transport Configuration

Listen IPs: Configurable via environment variables
UDP/TCP: Both enabled with UDP preference
DTLS/ICE: Enabled for secure communication

# 🎯 Usage

### Basic Video Call

Open the application in your browser
Grant camera and microphone permissions
The application will automatically join "room-1"
Other users joining the same room will appear in the remote videos section

### Screen Sharing

Click the "Start Screen Share" button
Select the screen/window you want to share
Your screen will be visible to other participants
Click "Stop Screen Share" to end sharing

### Room Management

Currently, the application uses a fixed room ID ("room-1"). To implement dynamic rooms:
javascript// Modify the ROOM_ID constant in VideoCall component
const ROOM_ID = "your-room-id";
🏃‍♂️ API Endpoints
Socket.IO Events
Client to Server

join-room: Join a specific room
get-rtp-capabilities: Get router RTP capabilities
create-transport: Create send/receive transport
connect-transport: Connect transport with DTLS parameters
produce: Create a new producer (camera/screen)
consume: Consume a remote producer
start-screen-share: Start screen sharing
stop-screen-share: Stop screen sharing

Server to Client

new-producer: Notification of new producer
screen-share-started: Screen share started notification
screen-share-stopped: Screen share stopped notification

# 🔍 Debug and Monitoring

The application includes a comprehensive debug console that shows:

Connection status
Transport creation and connection
Producer and consumer events
Screen sharing events
Error messages

# 🛡️ Security Considerations

DTLS: All media is encrypted using DTLS
ICE: Secure connection establishment
Origin Validation: Configure CORS appropriately for production
Room Access Control: Implement authentication for room access

🚀 Production Deployment
Backend Deployment

Set appropriate environment variables:

MEDIASOUP_ANNOUNCED_IP=<your-server-public-ip>
NODE_ENV=production

Configure firewall rules for MediaSoup:

# Allow MediaSoup transport ports (default range)

ufw allow 40000:49999/udp
ufw allow 40000:49999/tcp

Use PM2 or similar for process management:

npm install -g pm2
pm2 start dist/main.js --name mediasoup-backend
Frontend Deployment

# Build the React application:

npm run build

Serve using nginx or similar web server
Configure HTTPS (required for screen sharing)

# 🔧 Troubleshooting

Common Issues

Camera/Microphone not working

Check browser permissions
Ensure HTTPS is used (required for getUserMedia)

Screen sharing not available

HTTPS is required for getDisplayMedia
Check browser compatibility

Connection issues

Verify MEDIASOUP_ANNOUNCED_IP is correct
Check firewall settings
Ensure ports are open

No remote videos

Check debug console for errors
Verify transport creation success
Check consumer/producer creation

Debug Steps

Check browser console for errors
Monitor the debug panel in the application
Verify MediaSoup worker logs on the server
Test with multiple browser tabs/windows

# 📊 Performance Optimization

Video Quality: Adjust video constraints based on network conditions
Bitrate Management: Configure appropriate bitrate limits
Simulcast: Enable simulcast for better quality adaptation
Audio Processing: Use echo cancellation and noise suppression

🤝 Contributing

Fork the repository
Create a feature branch
Make your changes
Add tests if applicable
Submit a pull request

📄 License
This project is licensed under the MIT License - see the LICENSE file for details.
🙏 Acknowledgments

MediaSoup - WebRTC SFU library
NestJS - Backend framework
React - Frontend library
Socket.IO - Real-time communication

📞 Support
For issues and questions:

Check the troubleshooting section
Review MediaSoup documentation
Open an issue on GitHub

Note: This is a development setup. For production use, implement proper authentication, room management, and security measures.
