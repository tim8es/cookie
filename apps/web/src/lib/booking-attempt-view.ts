import type { BookingAttemptState } from "./booking-attempt.js";
import type { SlotView } from "./model.js";

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
        description:
          "Сервер подтвердил запись. Ниже указаны номер, время и фактическая стоимость.",
        announce: "status",
        canRetry: false,
      };
    case "conflict":
      if (state.refreshFailed) {
        return {
          title: "Выбранное время больше недоступно",
          description:
            "Не удалось обновить свободные интервалы. Вернитесь к выбору даты или попробуйте позже.",
          announce: "alert",
          canRetry: false,
        };
      }
      return {
        title: "Выбранное время больше недоступно",
        description:
          "Доступные интервалы обновлены сервером, но пока не зарезервированы.",
        announce: "alert",
        canRetry: false,
      };
    case "denied":
      if (state.reason === "unauthenticated") {
        return {
          title: "Необходимо восстановить сессию",
          description:
            "Сервер не подтвердил вашу сессию. Запись не подтверждена.",
          announce: "alert",
          canRetry: false,
        };
      }
      return {
        title: "Операция недоступна",
        description:
          "Сервер отклонил доступ. Повторение не обойдёт ограничение прав.",
        announce: "alert",
        canRetry: false,
      };
    case "error":
      if (
        state.reason === "unverified-conflict" ||
        state.reason === "idempotency-key-reused"
      ) {
        return {
          title: "Не удалось установить статус записи",
          description:
            "Не создавайте новую запись, пока салон не проверит результат запроса.",
          announce: "alert",
          canRetry: false,
        };
      }
      if (state.retryable) {
        return {
          title: "Не удалось получить подтверждение",
          description:
            "Ответ сервера не подтверждён. Повторная проверка использует ту же попытку, а не новую запись.",
          announce: "alert",
          canRetry: true,
        };
      }
      return {
        title: "Не удалось получить подтверждение",
        description:
          "Запись не подтверждена. Проверьте введённые данные или обратитесь в салон.",
        announce: "alert",
        canRetry: false,
      };
  }
}
