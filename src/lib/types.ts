export type Status = "online" | "dnd" | "invisible" | "offline";

export type Profile = {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  pronouns: string;
  color: string;
  bannerColor: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  status: Status;
  phone: string;
  email: string;
  hideOnline: boolean;
};

export type Channel = { id: string; serverId: string; name: string; type: "text" | "voice"; topic: string };

export type Server = {
  id: string;
  name: string;
  description: string;
  welcome: string;
  color: string;
  accent: string;
  bannerColor: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  ownerId: string;
  channels: Channel[];
  members: Profile[];
};

export type Conversation = { id: string; kind: "dm" | "group"; name: string | null; ownerId: string | null; members: Profile[] };

export type Message = {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  authorId: string;
  content: string;
  gifUrl: string | null;
  createdAt: string;
};

export type Notice = { id: string; title: string; body: string; read: boolean; createdAt: string };

export type Bootstrap = {
  me: Profile;
  friends: { user: Profile; since: string }[];
  incoming: Profile[];
  outgoing: Profile[];
  servers: Server[];
  conversations: Conversation[];
  notifications: Notice[];
  people: Profile[];
};
