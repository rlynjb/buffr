"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { IconX } from "@/components/icons";
import "./notification.css";

type NotificationType = "error" | "success" | "info";

interface Notification {
  id: number;
  type: NotificationType;
  message: string;
}

interface NotificationContextType {
  notify: (type: NotificationType, message: string) => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notify: () => {},
});

let nextId = 0;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const notify = useCallback((type: NotificationType, message: string) => {
    const id = nextId++;
    setNotifications((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 6000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return (
    <NotificationContext.Provider value={{ notify }}>
      {children}
      <div className="notification-container" aria-live="polite">
        {notifications.map((n) => (
          <NotificationToast
            key={n.id}
            notification={n}
            onDismiss={() => dismiss(n.id)}
          />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

export function useNotification() {
  return useContext(NotificationContext);
}

const typeClasses: Record<NotificationType, string> = {
  error: "notification--error",
  success: "notification--success",
  info: "notification--info",
};

function NotificationToast({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: () => void;
}) {
  return (
    <div className={`notification ${typeClasses[notification.type]}`}>
      <p className="notification__message">{notification.message}</p>
      <button onClick={onDismiss} className="notification__dismiss">
        <IconX size={14} />
      </button>
    </div>
  );
}
