export interface PhotoDerivativeNames {
  thumbnailName: string;
  previewName: string;
}

function photoScopePrefix(blobName: string): string | null {
  const [scope, ownerId] = blobName.split("/");
  if ((scope !== "personal" && scope !== "groups") || !ownerId) return null;
  return `${scope}/${ownerId}/`;
}

export function expectedPhotoDerivativeNames(
  originalName: string,
): PhotoDerivativeNames {
  const lastSlash = originalName.lastIndexOf("/");
  const directory = originalName.substring(0, lastSlash + 1);
  const filename = originalName.substring(lastSlash + 1);
  return {
    thumbnailName: `${directory}_th_${filename}.webp`,
    previewName: `${directory}_th_${filename}-prev.webp`,
  };
}

export function resolveListedPhotoDerivatives(
  originalName: string,
  listedDerivativeNames: ReadonlySet<string>,
  storedDerivativeNames: Partial<PhotoDerivativeNames> = {},
): Partial<PhotoDerivativeNames> {
  const expected = expectedPhotoDerivativeNames(originalName);
  const originalScope = photoScopePrefix(originalName);
  const isValidStoredName = (name: string | undefined): name is string =>
    Boolean(
      name
      && listedDerivativeNames.has(name)
      && originalScope
      && name.startsWith(originalScope),
    );

  return {
    ...(listedDerivativeNames.has(expected.thumbnailName)
      ? { thumbnailName: expected.thumbnailName }
      : isValidStoredName(storedDerivativeNames.thumbnailName)
        ? { thumbnailName: storedDerivativeNames.thumbnailName }
        : {}),
    ...(listedDerivativeNames.has(expected.previewName)
      ? { previewName: expected.previewName }
      : isValidStoredName(storedDerivativeNames.previewName)
        ? { previewName: storedDerivativeNames.previewName }
        : {}),
  };
}
