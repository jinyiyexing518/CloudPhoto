(() => {
  const messageType = "cloudphoto-private-cache-fence";
  let generation = 0;
  let enabled = true;

  const publish = () => {
    self.__cloudPhotoPrivateCacheGeneration = generation;
    self.__cloudPhotoPrivateCacheEnabled = enabled;
  };

  publish();
  self.addEventListener("message", (event) => {
    if (event.data?.type !== messageType) return;
    const reply = event.ports[0];
    if (event.data.command === "begin") {
      generation += 1;
      enabled = false;
      publish();
      reply?.postMessage({ ok: true, generation });
      return;
    }
    const canResume =
      event.data.command === "resume"
      && event.data.generation === generation;
    if (canResume) {
      enabled = true;
      publish();
    }
    reply?.postMessage({ ok: canResume, generation });
  });
})();
