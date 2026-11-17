export type AppearanceCodecFailureCode =
  | "invalid-image"
  | "output-too-large"
  | "codec-busy"
  | "codec-unavailable"
  | "codec-timeout";

export class AppearanceCodecFailure extends Error {
  constructor(readonly code: AppearanceCodecFailureCode) {
    super(code);
    this.name = "AppearanceCodecFailure";
  }
}
