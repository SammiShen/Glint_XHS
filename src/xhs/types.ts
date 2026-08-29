export interface NoteAuthor {
  userId: string;
  nickname: string;
  avatar?: string;
}

export interface SearchResultItem {
  noteId: string;
  url: string;
  title: string;
  type: "normal" | "video" | "unknown";
  author: NoteAuthor;
  cover?: string;
  likes?: number;
  collects?: number;
  comments?: number;
}

export interface NoteDetail {
  noteId: string;
  url: string;
  title: string;
  content: string;
  type: "normal" | "video" | "unknown";
  author: NoteAuthor;
  publishedAt?: string;
  images: string[];
  video?: string;
  tags: string[];
  likes?: number;
  collects?: number;
  comments?: number;
}

export interface NoteComment {
  commentId: string;
  content: string;
  likes: number;
  createdAt?: string;
  author: NoteAuthor;
  parentCommentId?: string;
  replies?: NoteComment[];
}

export interface UserProfile {
  userId: string;
  nickname: string;
  avatar?: string;
  description?: string;
  followers?: number;
  following?: number;
  noteCount?: number;
  notes: SearchResultItem[];
}
