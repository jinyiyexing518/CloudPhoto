export interface PhotoDerivativeNames {
  thumbnailName: string;
  previewName: string;
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
): Partial<PhotoDerivativeNames> {
  const expected = expectedPhotoDerivativeNames(originalName);
  return {
    ...(listedDerivativeNames.has(expected.thumbnailName)
      ? { thumbnailName: expected.thumbnailName }
      : {}),
    ...(listedDerivativeNames.has(expected.previewName)
      ? { previewName: expected.previewName }
      : {}),
  };
}
