import { useState, useEffect, useCallback } from "react";
import { listPhotos, uploadPhoto, deletePhoto, Photo } from "./services/photoApi";
import PhotoGallery from "./components/PhotoGallery";
import UploadArea from "./components/UploadArea";

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const fetchPhotos = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listPhotos();
      setPhotos(data);
    } catch {
      setError("Failed to load photos. Make sure the server is running.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  const handleUpload = async (files: FileList) => {
    setUploading(true);
    try {
      await Promise.all(Array.from(files).map((file) => uploadPhoto(file)));
      await fetchPhotos();
    } catch {
      setError("Failed to upload photo(s)");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deletePhoto(name);
      setPhotos((prev) => prev.filter((p) => p.name !== name));
    } catch {
      setError("Failed to delete photo");
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Cloud Photo</h1>
        <span className="photo-count">{photos.length} photos</span>
      </header>

      <main className="app-main">
        <UploadArea onUpload={handleUpload} uploading={uploading} />

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div className="loading">Loading photos...</div>
        ) : (
          <PhotoGallery photos={photos} onDelete={handleDelete} />
        )}
      </main>
    </div>
  );
}

export default App;
