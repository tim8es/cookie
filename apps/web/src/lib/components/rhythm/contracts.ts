export type RhythmPreviewTheme =
  | "workspace"
  | "studio"
  | "linen"
  | "graphite"
  | "sage";

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

export interface ChoiceItem {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  initials?: string;
  imageSrc?: string;
  disabled?: boolean;
}

export interface AccountOption extends ChoiceItem {
  initials: string;
  subtitle?: string;
}

export interface BookingStep {
  id: string;
  label: string;
  reachable: boolean;
  complete?: boolean;
}

export interface DayOption extends SegmentOption {
  weekday: string;
  day: string;
}

export interface ResourceGroup {
  id: string;
  label: string;
  shiftLabel?: string;
  visits: readonly (VisitDisplay & { id: string })[];
}

export interface ScheduleDisplay {
  label: string;
  period: string;
  status: string;
}

export interface MetricItem {
  id: string;
  value: string;
  label: string;
}

export type MenuOption = SegmentOption;

export interface ModuleDisplay {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
  locked?: boolean;
}
