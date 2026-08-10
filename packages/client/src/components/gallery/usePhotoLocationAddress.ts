import { useEffect, useState } from "react";
import type { Photo } from "../../services/photoApi";
import { reverseGeocode } from "../../utils/geocode";
import { readGpsCoordinates } from "../../utils/gpsCoordinates";

function workspaceForPhoto(name: string): string {
  const [kind = "", owner = ""] = name.split("/");
  return `${kind}/${owner}`;
}

export function usePhotoLocationAddress(photo: Photo | null): {
  address: string | null;
  loading: boolean;
  status: "missing-coordinates" | "loading" | "resolved" | "unavailable";
} {
  const photoName = photo?.name ?? "";
  const gps = readGpsCoordinates(photo?.gpsLat, photo?.gpsLon);
  const lat = gps?.lat ?? Number.NaN;
  const lon = gps?.lon ?? Number.NaN;
  const identity = `${photoName}:${photo?.gpsLat ?? ""}:${photo?.gpsLon ?? ""}`;
  const hasCoordinates = Boolean(photoName) && Number.isFinite(lat) && Number.isFinite(lon);
  const [result, setResult] = useState<{
    identity: string;
    address: string | null;
    loading: boolean;
    status: "missing-coordinates" | "loading" | "resolved" | "unavailable";
  }>({ identity: "", address: null, loading: false, status: "missing-coordinates" });

  useEffect(() => {
    const controller = new AbortController();
    setResult({
      identity,
      address: null,
      loading: hasCoordinates,
      status: hasCoordinates ? "loading" : "missing-coordinates",
    });
    if (!hasCoordinates) {
      return () => controller.abort();
    }

    void reverseGeocode(lat, lon, {
      signal: controller.signal,
      workspace: workspaceForPhoto(photoName),
    }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setResult({
            identity,
            address: value,
            loading: false,
            status: value ? "resolved" : "unavailable",
          });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
          setResult({ identity, address: null, loading: false, status: "unavailable" });
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
    ? { address: result.address, loading: result.loading, status: result.status }
    : {
        address: null,
        loading: hasCoordinates,
        status: hasCoordinates ? "loading" : "missing-coordinates",
      };
}
