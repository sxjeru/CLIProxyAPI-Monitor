"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
  backdropClassName?: string;
  darkMode?: boolean;
}

export function Modal({ 
  isOpen, 
  onClose, 
  children, 
  title, 
  className, 
  backdropClassName,
  darkMode = true 
}: ModalProps) {
  const [isVisible, setIsVisible] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [cachedChildren, setCachedChildren] = useState<React.ReactNode>(null);
  const [cachedTitle, setCachedTitle] = useState<string | undefined>(title);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setIsClosing(false);
      setCachedChildren(children);
      setCachedTitle(title);
    } else if (isVisible) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setIsVisible(false);
        setIsClosing(false);
        setCachedChildren(null);
        setCachedTitle(undefined);
      }, 200); // Match animation duration
      return () => clearTimeout(timer);
    }
  }, [isOpen, isVisible, children, title]);

  if (!isVisible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm transition-all ${
        backdropClassName ?? "bg-black/50"
      } ${
        isClosing ? "animate-modal-backdrop-out" : "animate-modal-backdrop"
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`relative w-full rounded-2xl p-6 shadow-xl ${
          darkMode ? "bg-slate-800" : "bg-white"
        } ${className ?? "max-w-md"} ${
          isClosing ? "animate-modal-content-out" : "animate-modal-content"
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          className={`absolute right-4 top-4 rounded-lg p-1 transition ${
            darkMode
              ? "text-slate-400 hover:bg-slate-700 hover:text-white"
              : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"
          }`}
        >
          <X className="h-5 w-5" />
        </button>
        {(isOpen ? title : cachedTitle) && (
          <h3 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>
            {isOpen ? title : cachedTitle}
          </h3>
        )}
        {isOpen ? children : cachedChildren}
      </div>
    </div>
  );
}
