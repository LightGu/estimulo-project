class AIProviderAdapter {
  constructor(options = {}) {
    this.options = options;
  }

  async generateCaption() {
    throw new Error("AIProviderAdapter.generateCaption must be implemented");
  }

  async transcribe(downloadedVideo, options = {}) {
    return this.generateCaption(downloadedVideo, options);
  }
}

module.exports = AIProviderAdapter;
