export const SOCKET_URL =
  (import.meta.env.WXT_SOCKET_ENDPOINT as string) || "http://localhost:3001"

export const MAX_ROOM_PARTICIPANTS = 10
export type ControlMode = "shared" | "host"

export type RoomParticipant = {
  id: string
  nickname: string
  isHost: boolean
}

export type RoomState = {
  roomId: string
  hostId: string
  controlMode: ControlMode
  participants: RoomParticipant[]
  participantCount: number
  maxParticipants: number
}

export type JoinRoomPayload = {
  roomId: string
  nickname: string
  participantId: string
  controlMode?: ControlMode
  pageUrl?: string
}

export type LeaveRoomPayload = {
  roomId: string
  participantId: string
}

export type RoomErrorPayload = {
  roomId: string
  code: "full" | "not_found" | "invalid_room"
  message: string
}

export enum SOCKET_EVENTS {
  CREATE = "create",
  JOIN = "join",
  FULL = "full",
  LOG = "log",
  VIDEO_EVENT = "videoEvent",
  CHAT_MESSAGE = "chatMessage",
  REACTION = "reaction",
  LEAVE = "leaveRoom",
  SYNC_PING = "syncPing",
  SYNC_PONG = "syncPong",
  ROOM_JOINED = "roomJoined",
  ROOM_UPDATED = "roomUpdated",
  ROOM_ERROR = "roomError",
  // Voice chat signaling
  VOICE_CONNECT = "voiceConnect",
  VOICE_JOIN = "voiceJoin",
  VOICE_LEAVE = "voiceLeave",
  VOICE_OFFER = "voiceOffer",
  VOICE_ANSWER = "voiceAnswer",
  VOICE_ICE_CANDIDATE = "voiceIceCandidate",
  VOICE_MUTE_TOGGLE = "voiceMuteToggle",
  VOICE_STATE_UPDATED = "voiceStateUpdated",
  VOICE_PEER_JOINED = "voicePeerJoined",
  VOICE_PEER_LEFT = "voicePeerLeft"
}

export type VoiceOfferPayload = {
  fromParticipantId: string
  sdp: RTCSessionDescriptionInit
}

export type VoiceAnswerPayload = {
  fromParticipantId: string
  sdp: RTCSessionDescriptionInit
}

export type VoiceIceCandidatePayload = {
  fromParticipantId: string
  candidate: RTCIceCandidateInit
}

export type VoiceMutePayload = {
  participantId: string
  muted: boolean
}

export type VoicePeerJoinedPayload = {
  participantId: string
}

export type VoicePeerLeftPayload = {
  participantId: string
}

export type VoiceStateUpdatedPayload = {
  voiceParticipants: string[]
}
