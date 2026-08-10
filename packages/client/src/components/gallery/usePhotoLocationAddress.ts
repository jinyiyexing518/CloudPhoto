import { useEffect, useState } from "react";
import type { Photo } from "../../services/photoApi";
import { reverseGeocode } from "../../utils/geocode";

function workspaceForPhoto(name: string): string {
  const [kind = "", owner = ""] = name.split("/");
  return `${kind}/${owner}`;
}

function parseCoordinate(raw: string | undefined): number {
  return raw?.trim() ? Number(raw) : Number.NaN;
}

export function usePhotoLocationAddress(photo: Photo | null): {
  address: string | null;
  loading: boolean;
} {
  const photoName = photo?.name ?? "";
  const lat = parseCoordinate(photo?.gpsLat);
  const lon = parseCoordinate(photo?.gpsLon);
  const identity = `${photoName}:${photo?.gpsLat ?? ""}:${photo?.gpsLon ?? ""}`;
  const hasCoordinates = Boolean(photoName) && Number.isFinite(lat) && Number.isFinite(lon);
  const [result, setResult] = useState<{
    identity: string;
    address: string | null;
    loading: boolean;
  }>({ identity: "", address: null, loading: false });

  useEffect(() => {
    const controller = new AbortController();
    setResult({ identity, address: null, loading: hasCoordinates });
    if (!hasCoordinates) {
      return () => controller.abort();
    }

    void reverseGeocode(lat, lon, {
      signal: controller.signal,
      workspace: workspaceForPhoto(photoName),
    }).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ identity, address: value, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
          setResult({ identity, address: null, loading: false });
        }
      },
    ).finally(() => {
      if (!controller.signal.aborted) {
        setResult((current) => current.identity === identity
          ? { ...current, loading: false }
          : current);
      }
    });
    return () => controller.abort(new DOMException("Photo changed", "AbortError"));
  }, [hasCoordinates, identity, lat, lon, photoName]);

  return result.identity === identity
    ? { address: result.address, loading: result.loading }
    : { address: null, loading: hasCoordinates };
}
