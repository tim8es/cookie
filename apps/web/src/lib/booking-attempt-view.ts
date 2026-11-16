import type { BookingAttemptState } from "./booking-attempt";
import type { SlotView } from "./model";

/**
 * Presentation-only receipt populated by a reviewed, schema-validating server
 * adapter. These are DISPLAY STRINGS, never HTTP DTO fields, prices calculated
 * in JavaScript, or unverified optimistic booking data.
 */
export interface ConfirmedBookingReceiptView {
  bookingId: string;
  dateTimeText: string;
  finalPriceText: string;
}

export type ClientBookingState = BookingAttemptState<
  ConfirmedBookingReceiptView,
  SlotView
>;

export interface BookingFeedbackCopy {
  title: string;
  description: string;
  announce: "status" | "alert";
  canRetry: boolean;
}

/**
 * Keep state-specific language shared between web/mobile/Telegram surfaces.
 * An uncertain transport response must never read as a confirmed booking.
 */
export function bookingFeedback(
  state: ClientBookingState,
): BookingFeedbackCopy | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "submitting":
      return {
        title: "Проверяем возможность записи…",
        description: "Ожидаем ответа сервера. Пока запись не подтверждена.",
        announce: "status",
        canRetry: false,
      };
    case "confirmed":
      return {
        title: "Запись подтверждена",
        description: "Сервер подтвердил запись. Ниже указаны номер, время и фактическая стоимость.",
        announce: "status",
        canRetry: false,
      };
    case "conflict":
      return {
        title: "Выбранное время больше недоступно",
        description: state.refreshFailed
          ? "Не удалось обновить свободные интервалы. Вернитесь к выбору даты или попробуйте позже."
          : "Доступные интервалы обновлены сервером, но пока не зарезервированы.",
        announce: "alert",
        canRetry: false,
      };
    case "denied":
      return {
        title: state.reason === "unauthenticated"
          ? "Необходимо восстановить сессию"
          : "Операция недоступна",
        description: state.reason === "unauthenticated"
          ? "Сервер не подтвердил вашу сессию. Запись не подтверждена."
          : "Сервер отклонил доступ. Повторение не обойдёт ограничение прав.",
        announce: "alert",
        canRetry: false,
      };
    case "error": {
      const ambiguous =
        state.reason === "unverified-conflict" ||
        state.reason === "idempotency-key-reused";
      return {
        title: ambiguous
          ? "Не удалось установить статус записи"
          : "Не удалось получить подтверждение",
        description: ambiguous
          ? "Не создавайте новую запись, пока салон не проверит результат запроса."
          : state.retryable
            ? "Ответ сервера не подтверждён. Повторная проверка использует ту же попытку, а не новую запись."
            : "Запись не подтверждена. Проверьте введённые данные или обратитесь в салон.",
        announce: "alert",
        canRetry: state.retryable && !ambiguous,
      };
    }
  }
}
