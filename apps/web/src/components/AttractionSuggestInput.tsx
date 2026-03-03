"use client";

/**
 * AttractionSuggestInput — autocomplete input for attraction names.
 *
 * Dropdown is rendered position:absolute inside a position:relative wrapper so
 * it overlays content below without affecting layout flow.  This is simpler and
 * more mobile-reliable than the previous portal+fixed approach: on iOS the soft
 * keyboard changes the visual viewport, which made getBoundingClientRect values
 * stale by the time the portal div was painted, causing incorrect placement.
 * With position:absolute the dropdown follows the input's containing block
 * automatically regardless of keyboard state.
 *
 * Clipping: any ancestor with overflow:hidden between this component and the
 * nearest scroll container must have that property removed (the Plans modal's
 * overflow:hidden was removed for this reason).
 *
 * Mobile-safe: items use onPointerDown + preventDefault so the blur fired when
 * the user taps a list item doesn't dismiss the list before selection registers.
 */

import { useState } from "react";
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

  // Filter suggestions: case-insensitive, order-agnostic substring match via normalizeKey.
  const filtered =
    value.trim().length >= 1
      ? suggestions.filter((s) => normalizeKey(s).includes(normalizeKey(value)))
      : [];

  const showDrop = open && filtered.length > 0;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
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

      {showDrop && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            marginTop: 0,
            zIndex: 9999,
            background: "#fff",
            border: "1px solid #d1d5db",
            borderTop: 0,
            borderRadius: "0 0 8px 8px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
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
                display: "flex",
                alignItems: "center",
                minHeight: 44,
                padding: "0 0.875rem",
                cursor: "pointer",
                fontSize: "0.95rem",
                color: "#111827",
                borderBottom: "1px solid #f3f4f6",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "#f3f4f6";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "";
              }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
