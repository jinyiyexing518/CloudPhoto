const API_BASE = "/api";

export interface Photo {
  name: string;
  url: string;
  size: number;
  lastModified: string;
  contentType: string;
}

export async function listPhotos(): Promise<Photo[]> {
  const response = await fetch(`${API_BASE}/photos`);
  if (!response.ok) throw new Error("Failed to fetch photos");
  return response.json() as Promise<Photo[]>;
}

export async function uploadPhoto(file: File): Promise<Photo> {
  const response = await fetch(
    `${API_BASE}/photos/upload?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }
  );
  if (!response.ok) throw new Error("Failed to upload photo");
  return response.json() as Promise<Photo>;
}

export async function deletePhoto(name: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/photos/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
  if (!response.ok) throw new Error("Failed to delete photo");
}
