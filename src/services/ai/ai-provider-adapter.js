class AIProviderAdapter {
  constructor(options = {}) {
    this.options = options;
  }

  async generateCaption() {
    throw new Error("AIProviderAdapter.generateCaption must be implemented");
  }

  async generateCaptionFromTranscript() {
    throw new Error("AIProviderAdapter.generateCaptionFromTranscript must be implemented");
  }

  async reviewCaptionConsistency() {
    throw new Error("AIProviderAdapter.reviewCaptionConsistency must be implemented");
  }

  async transcribe(downloadedVideo, options = {}) {
    return this.generateCaption(downloadedVideo, options);
  }
}

module.exports = AIProviderAdapter;
