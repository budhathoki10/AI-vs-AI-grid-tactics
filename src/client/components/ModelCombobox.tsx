import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModelOption } from "../../ai/protocol";

const MAX_VISIBLE_OPTIONS = 60;

interface Props {
  id: string;
  value: string;
  onChange: (id: string) => void;
  options: ModelOption[];
  loading: boolean;
  error: string | null;
  invalid: boolean;
}

/** Searchable picker over OpenRouter's few hundred models; any typed id is accepted so new models work before the list refreshes. */
export function ModelCombobox({ id, value, onChange, options, loading, error, invalid }: Props) {
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  /** -1 until the user moves or types, so Enter keeps the current model. */
  const [highlight, setHighlight] = useState(-1);
  useEffect(() => setQuery(value), [value]);

  const matches = useMemo(() => {
    // An untouched field holds the chosen id; filtering by it would hide every other model.
    const needle = query === value ? "" : query.trim().toLowerCase();
    const filtered = needle ? options.filter((o) => `${o.id} ${o.label}`.toLowerCase().includes(needle)) : options;
    return filtered.slice(0, MAX_VISIBLE_OPTIONS);
  }, [options, query, value]);

  useEffect(() => {
    list.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const choose = (next: string) => {
    setQuery(next);
    onChange(next);
    setOpen(false);
    setHighlight(-1);
  };
  const expanded = open && matches.length > 0;

  return (
    <div className="combo">
      <input
        id={id}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && matches[highlight] ? `${listId}-${highlight}` : undefined}
        aria-invalid={invalid}
        value={query}
        placeholder={loading ? "Loading models…" : "Search, e.g. deepseek or openai/gpt-4o"}
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setHighlight(-1);
          if (query.trim() !== value) onChange(query.trim());
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(open && matches[highlight] ? matches[highlight].id : query.trim());
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery(value);
          }
        }}
      />
      <ul ref={list} id={listId} role="listbox" aria-label="OpenRouter models" className="combo-list" hidden={!expanded}>
        {expanded &&
          matches.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={`combo-option${option.id === value ? " is-current" : ""}`}
              onMouseEnter={() => setHighlight(index)}
              // Mouse down, not click: it must run before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(option.id);
              }}
            >
              <span className="combo-name">{option.label}</span>
              <span className="combo-meta">
                <span>{option.id}</span>
                {option.hint && <span>{option.hint}</span>}
              </span>
            </li>
          ))}
      </ul>
      {error && <p className="field-hint">{error}. You can still type a model id.</p>}
    </div>
  );
}
