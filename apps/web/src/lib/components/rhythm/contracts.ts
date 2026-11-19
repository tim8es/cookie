export type RhythmPreviewTheme = "workspace" | "studio" | "linen" | "graphite" | "sage";

export interface SegmentOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface DisplayRecord {
  title: string;
  subtitle?: string;
  detail?: string;
  initials?: string;
  imageSrc?: string;
}

export interface VisitDisplay {
  time: string;
  title: string;
  subtitle?: string;
  status: string;
  amountLabel?: string;
}

export interface TicketLine {
  label: string;
  value: string;
}
