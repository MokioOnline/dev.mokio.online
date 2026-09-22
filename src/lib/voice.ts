import { mokio } from "./supabase";
import { nid } from "./api";

const ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type PeerInfo = { userId: string; username: string };

const pcs = new Map<string, RTCPeerConnection>();
const remotes = new Map<string, MediaStream>();
const makingOffer = new Set<string>();
const listeners = new Set<() => void>();

let roomId: string | null = null;
let roomLabel = "";
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let peers: PeerInfo[] = [];
let muted = false;
let cameraOn = false;
let selfId = "";
let channel: ReturnType<typeof mokio.channel> | null = null;

function notify() {
  listeners.forEach((fn) => fn());
}

export function onVoiceChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getVoiceRoom() {
  return roomId ? { id: roomId, label: roomLabel } : null;
}
export function getVoicePeers() {
  return peers;
}
export function getVoiceLocal() {
  return localStream;
}
export function getVoiceScreen() {
  return screenStream;
}
export function getVoiceRemotes() {
  return [...remotes.entries()];
}
export function isMuted() {
  return muted;
}
export function hasCamera() {
  return cameraOn;
}
export function isSharingScreen() {
  return !!screenStream?.getVideoTracks().some((t) => t.readyState === "live");
}
export function isScreenTrack(track: MediaStreamTrack) {
  return track.contentHint === "detail" || /screen|window|display|monitor/i.test(track.label);
}

async function ensureMic() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    localStream = new MediaStream();
  }
  notify();
  return localStream;
}

function addLocalTracks(pc: RTCPeerConnection) {
  const senders = pc.getSenders();
  const has = (track: MediaStreamTrack) => senders.some((s) => s.track?.id === track.id);
  localStream?.getTracks().forEach((t) => {
    if (!has(t)) pc.addTrack(t, localStream!);
  });
  screenStream?.getTracks().forEach((t) => {
    if (!has(t)) {
      t.contentHint = "detail";
      pc.addTrack(t, screenStream!);
    }
  });
}

async function sendSignal(to: string, kind: string, payload: unknown) {
  if (!roomId) return;
  await mokio.from("mokio_call_signals").insert({
    id: nid(),
    room_id: roomId,
    from_id: selfId,
    to_id: to,
    kind,
    payload: JSON.stringify(payload),
  });
}

async function ensurePc(peerId: string) {
  let pc = pcs.get(peerId);
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: ICE });
  pcs.set(peerId, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) void sendSignal(peerId, "ice", e.candidate);
  };
  pc.ontrack = (e) => {
    let stream = remotes.get(peerId);
    if (!stream) {
      stream = new MediaStream();
      remotes.set(peerId, stream);
    }
    if (!stream.getTracks().some((t) => t.id === e.track.id)) stream.addTrack(e.track);
    notify();
  };
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer.add(peerId);
      await pc!.setLocalDescription(await pc!.createOffer());
      await sendSignal(peerId, "offer", pc!.localDescription);
    } catch {
      /* glare */
    } finally {
      makingOffer.delete(peerId);
    }
  };
  addLocalTracks(pc);
  notify();
  return pc;
}

async function handleSignal(from: string, kind: string, payload: string) {
  const data = JSON.parse(payload);
  const pc = await ensurePc(from);
  if (kind === "offer") {
    const offerCollision = makingOffer.has(from) || pc.signalingState !== "stable";
    const polite = selfId < from;
    if (offerCollision && !polite) return;
    await pc.setRemoteDescription(data);
    await pc.setLocalDescription(await pc.createAnswer());
    await sendSignal(from, "answer", pc.localDescription);
  } else if (kind === "answer") {
    if (pc.signalingState !== "have-local-offer") return;
    await pc.setRemoteDescription(data);
  } else if (kind === "ice") {
    try {
      await pc.addIceCandidate(data);
    } catch {
      /* ignore */
    }
  }
}

async function heartbeat() {
  if (!roomId) return;
  await mokio.from("mokio_call_peers").upsert({
    room_id: roomId,
    user_id: selfId,
    username: selfId.slice(0, 8),
    heartbeat_at: new Date().toISOString(),
  });
}

export async function joinVoice(_ignored: unknown, meId: string, id: string, label: string) {
  selfId = meId;
  roomId = id;
  roomLabel = label;
  await ensureMic();
  await mokio.from("mokio_call_peers").upsert({
    room_id: id,
    user_id: meId,
    username: meId.slice(0, 8),
    heartbeat_at: new Date().toISOString(),
  });
  const { data } = await mokio.from("mokio_call_peers").select("*").eq("room_id", id);
  peers = (data || []).filter((p) => p.user_id !== meId).map((p) => ({ userId: p.user_id, username: p.username }));
  for (const p of peers) await ensurePc(p.userId);

  channel?.unsubscribe();
  channel = mokio
    .channel("call-" + id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "mokio_call_signals", filter: `to_id=eq.${meId}` }, (payload) => {
      const row = payload.new as { room_id: string; from_id: string; kind: string; payload: string };
      if (row.room_id !== id) return;
      void handleSignal(row.from_id, row.kind, row.payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "mokio_call_peers", filter: `room_id=eq.${id}` }, async () => {
      const { data: list } = await mokio.from("mokio_call_peers").select("*").eq("room_id", id);
      peers = (list || []).filter((p) => p.user_id !== meId).map((p) => ({ userId: p.user_id, username: p.username }));
      for (const p of peers) await ensurePc(p.userId);
      notify();
    })
    .subscribe();

  const beat = window.setInterval(() => void heartbeat(), 4000);
  (joinVoice as { beat?: number }).beat = beat;
  notify();
}

export function toggleVoiceMute() {
  muted = !muted;
  localStream?.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
  notify();
}

export async function toggleVoiceCamera() {
  if (!localStream) await ensureMic();
  const existing = localStream?.getVideoTracks().find((t) => !isScreenTrack(t));
  if (existing) {
    existing.stop();
    localStream?.removeTrack(existing);
    cameraOn = false;
    pcs.forEach((pc) => {
      pc.getSenders().forEach((snd) => {
        if (snd.track?.id === existing.id) pc.removeTrack(snd);
      });
    });
    notify();
    return;
  }
  try {
    const cam = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } },
      audio: false,
    });
    const track = cam.getVideoTracks()[0];
    if (!track) return;
    track.contentHint = "motion";
    localStream?.addTrack(track);
    cameraOn = true;
    pcs.forEach((pc) => pc.addTrack(track, localStream!));
  } catch {
    cameraOn = false;
  }
  notify();
}

export async function shareVoiceScreen() {
  if (isSharingScreen()) {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
    notify();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    stream.getVideoTracks().forEach((t) => {
      t.contentHint = "detail";
      t.onended = () => {
        screenStream = null;
        notify();
      };
    });
    screenStream = stream;
    pcs.forEach((pc) => addLocalTracks(pc));
  } catch {
    /* cancelled */
  }
  notify();
}

export async function hangUp() {
  const beat = (joinVoice as { beat?: number }).beat;
  if (beat) window.clearInterval(beat);
  if (roomId && selfId) {
    await mokio.from("mokio_call_peers").delete().eq("room_id", roomId).eq("user_id", selfId);
  }
  channel?.unsubscribe();
  channel = null;
  pcs.forEach((pc) => pc.close());
  pcs.clear();
  remotes.clear();
  localStream?.getTracks().forEach((t) => t.stop());
  screenStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  screenStream = null;
  roomId = null;
  roomLabel = "";
  peers = [];
  cameraOn = false;
  muted = false;
  notify();
}
