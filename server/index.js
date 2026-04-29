const http = require("http")
const { Server } = require("socket.io")

const PORT = Number(process.env.PORT || 3001)
const ROOM_CODE_LENGTH = 5
const MAX_ROOM_PARTICIPANTS = 10

/** @type {Map<string, {
 *   roomId: string,
 *   hostId: string,
 *   controlMode: "shared" | "host",
 *   hostUrl: string,
 *   participants: Map<string, { id: string, nickname: string, isHost: boolean }>,
 *   socketsByParticipant: Map<string, string>,
 *   maxParticipants: number
 * }>} */
const rooms = new Map()

function applyCorsHeaders(res, req) {
  const origin = req.headers.origin || "*"
  res.setHeader("access-control-allow-origin", origin)
  res.setHeader("vary", "origin")
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type")
  res.setHeader("access-control-allow-private-network", "true")
}

function log(event, details) {
  console.log(`[couch-server][${event}]`, details)
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

function createRoom() {
  let roomId = generateRoomCode()
  while (rooms.has(roomId)) roomId = generateRoomCode()

  rooms.set(roomId, {
    roomId,
    hostId: "",
    controlMode: "shared",
    hostUrl: "",
    participants: new Map(),
    socketsByParticipant: new Map(),
    maxParticipants: MAX_ROOM_PARTICIPANTS
  })
  return roomId
}

function getPublicRoomState(room) {
  const participants = Array.from(room.participants.values())
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    controlMode: room.controlMode,
    participants,
    participantCount: participants.length,
    maxParticipants: room.maxParticipants
  }
}

function removeParticipant(room, participantId) {
  room.participants.delete(participantId)
  room.socketsByParticipant.delete(participantId)

  if (room.hostId === participantId) {
    const nextHost = room.participants.values().next().value
    room.hostId = nextHost ? nextHost.id : ""
    if (nextHost) nextHost.isHost = true
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/create") {
    const roomId = createRoom()
    log("create", { roomId })
    applyCorsHeaders(res, req)
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8"
    })
    res.end(roomId)
    return
  }

  if (req.method === "GET" && req.url?.startsWith("/room/")) {
    const parts = req.url.split("/")
    const roomId = (parts[2] || "").toUpperCase()
    const action = parts[3] || ""
    if (action === "url" && roomId) {
      const room = rooms.get(roomId)
      if (!room || !room.hostUrl) {
        applyCorsHeaders(res, req)
        res.writeHead(404, {
          "content-type": "application/json; charset=utf-8"
        })
        res.end(JSON.stringify({ message: "Host URL not available yet." }))
        return
      }

      applyCorsHeaders(res, req)
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8"
      })
      res.end(JSON.stringify({ roomId, url: room.hostUrl }))
      return
    }
  }

  if (req.method === "OPTIONS") {
    applyCorsHeaders(res, req)
    res.writeHead(204)
    res.end()
    return
  }

  applyCorsHeaders(res, req)
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8"
  })
  res.end(JSON.stringify({ ok: true, service: "couch-room-server", port: PORT }))
})

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"]
  }
})

io.engine.on("initial_headers", (headers, req) => {
  headers["Access-Control-Allow-Origin"] = req.headers.origin || "*"
  headers["Vary"] = "Origin"
  headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
  headers["Access-Control-Allow-Headers"] = "content-type"
  headers["Access-Control-Allow-Private-Network"] = "true"
})

io.engine.on("headers", (headers, req) => {
  headers["Access-Control-Allow-Origin"] = req.headers.origin || "*"
  headers["Vary"] = "Origin"
  headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
  headers["Access-Control-Allow-Headers"] = "content-type"
  headers["Access-Control-Allow-Private-Network"] = "true"
})

io.on("connection", (socket) => {
  log("connect", { socketId: socket.id })

  socket.on("join", (payload) => {
    const roomId = (payload?.roomId || "").toUpperCase()
    const participantId = payload?.participantId
    const nickname = payload?.nickname || "Anonymous"
    const controlMode = payload?.controlMode === "host" ? "host" : "shared"

    const room = rooms.get(roomId)
    log("join.attempt", {
      socketId: socket.id,
      roomId,
      participantId,
      nickname,
      knownRoom: !!room
    })
    if (!room || !participantId) {
      socket.emit("roomError", {
        roomId,
        code: "invalid_room",
        message: "Invalid room."
      })
      return
    }

    const hasParticipant = room.participants.has(participantId)
    const previousSocketForParticipant = room.socketsByParticipant.get(participantId)
    if (!hasParticipant && room.participants.size >= room.maxParticipants) {
      socket.emit("full", roomId)
      socket.emit("roomError", {
        roomId,
        code: "full",
        message: "Room is full."
      })
      return
    }

    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.participantId = participantId

    const isFirstParticipant = room.participants.size === 0
    if (isFirstParticipant) {
      room.hostId = participantId
      room.controlMode = controlMode
    }
    if (
      payload?.pageUrl &&
      (room.hostId === participantId || isFirstParticipant) &&
      (payload.pageUrl.startsWith("http://") ||
        payload.pageUrl.startsWith("https://"))
    ) {
      room.hostUrl = payload.pageUrl
    }

    room.participants.set(participantId, {
      id: participantId,
      nickname,
      isHost: room.hostId === participantId
    })
    room.socketsByParticipant.set(participantId, socket.id)

    const state = getPublicRoomState(room)
    log("join.success", {
      socketId: socket.id,
      roomId,
      participantId,
      hasParticipant,
      previousSocketForParticipant: previousSocketForParticipant || null,
      participantCount: state.participantCount,
      hostId: state.hostId
    })
    socket.emit("roomJoined", state)
    io.to(roomId).emit("roomUpdated", state)
  })

  socket.on("leaveRoom", (payload) => {
    const roomId = payload?.roomId || socket.data.roomId
    const participantId = payload?.participantId || socket.data.participantId
    if (!roomId || !participantId) return

    const room = rooms.get(roomId)
    if (!room) return

    removeParticipant(room, participantId)
    socket.leave(roomId)
    log("leave", {
      socketId: socket.id,
      roomId,
      participantId,
      participantCount: room.participants.size
    })

    if (room.participants.size === 0) {
      rooms.delete(roomId)
      return
    }

    io.to(roomId).emit("roomUpdated", getPublicRoomState(room))
  })

  socket.on("videoEvent", (roomId, eventType, volumeValue, currentTime) => {
    socket.to(roomId).emit(
      "videoEvent",
      eventType,
      volumeValue,
      currentTime,
      Date.now()
    )
  })

  socket.on("chatMessage", (roomId, message) => {
    if (typeof message?.text === "string" && message.text.startsWith("__COUCH_")) {
      log("chat.sync", {
        socketId: socket.id,
        roomId,
        text: message.text
      })
    }
    io.to(roomId).emit("chatMessage", message)
  })

  socket.on("reaction", (roomId, data) => {
    io.to(roomId).emit("reaction", data)
  })

  socket.on("syncPing", (payload) => {
    socket.emit("syncPong", {
      clientSendTs: payload?.clientSendTs,
      serverTs: Date.now()
    })
  })

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId
    const participantId = socket.data.participantId
    if (!roomId || !participantId) return

    const room = rooms.get(roomId)
    if (!room) return

    if (room.socketsByParticipant.get(participantId) !== socket.id) return

    removeParticipant(room, participantId)
    log("disconnect", {
      socketId: socket.id,
      roomId,
      participantId,
      participantCount: room.participants.size
    })
    if (room.participants.size === 0) {
      rooms.delete(roomId)
      return
    }

    io.to(roomId).emit("roomUpdated", getPublicRoomState(room))
  })
})

server.listen(PORT, () => {
  console.log(`[couch-server] listening on http://localhost:${PORT}`)
})
