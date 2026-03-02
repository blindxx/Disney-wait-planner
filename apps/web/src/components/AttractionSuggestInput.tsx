"use client";

/**
 * AttractionSuggestInput — autocomplete input for attraction names.
 *
 * Renders the suggestion dropdown via React portal into document.body so it
 * is never clipped by ancestor overflow:hidden / overflow-y:auto containers
 * (e.g. the Plans modal-body or Lightning card).
 *
 * Uses useLayoutEffect (not useEffect) to position the dropdown so it is
 * placed before the browser paints — eliminating the one-frame flash where
 * the unstyled portal div would briefly appear in layout flow.
 *
 * Mobile-safe: items use onPointerDown + preventDefault so the blur event
 * fired when the user taps outside the input doesn't dismiss the list before
 * the selection is registered.
 */

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { normalizeKey } from "@/lib/plansMatching";

type Props = {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  /** CSS className applied to the <input> element */
  inputClassName?: string;
  /** Inline style applied to the <input> element */
  inputStyle?: React.CSSProperties;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
};

export function AttractionSuggestInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  inputClassName,
  inputStyle,
  onKeyDown,
  autoFocus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});

  // Only portal-render after client mount (document.body is available).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Filter suggestions: case-insensitive, order-agnostic substring match via normalizeKey.
  const filtered =
    value.trim().length >= 1
      ? suggestions.filter((s) => normalizeKey(s).includes(normalizeKey(value)))
      : [];

  const showDrop = open && filtered.length > 0;

  // Recompute fixed dropdown position synchronously before paint so the portal
  // div is never rendered unstyled (which caused a one-frame layout-flow flash).
  useLayoutEffect(() => {
    if (showDrop && inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setDropStyle({
        position: "fixed",
        top: r.bottom + 2,
        left: r.left,
        width: r.width,
        zIndex: 9999,
        background: "#fff",
        border: "1px solid #d1d5db",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        maxHeight: 220,
        overflowY: "auto",
      });
    }
  }, [showDrop, value]);

  return (
    <div style={{ position: "relative" }}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        className={inputClassName}
        style={inputStyle}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Small delay so onPointerDown on a list item fires first.
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          onKeyDown?.(e);
        }}
      />
      {showDrop &&
        mounted &&
        createPortal(
          <div style={dropStyle}>
            {filtered.map((s) => (
              <div
                key={s}
                onPointerDown={(e) => {
                  // Prevent blur from dismissing the list before selection.
                  e.preventDefault();
                  onChange(s);
                  setOpen(false);
                }}
                style={{
                  padding: "0.6rem 0.875rem",
                  cursor: "pointer",
                  fontSize: "0.95rem",
                  color: "#111827",
                  borderBottom: "1px solid #f3f4f6",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background =
                    "#f3f4f6";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "";
                }}
              >
                {s}
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
