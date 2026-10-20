import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * 带动画的下拉选择。
 *
 * 原生 <select> 在 Windows / Chrome 里没有可控制的展开动画，也不能显示副说明。
 * 这里用 button + listbox 重做，只保留原生控件的基本键盘行为：
 * ↑ / ↓ / Home / End / Enter / Escape，焦点始终留在触发器上。
 */
export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, selectedIndex]);

  function choose(option: SelectOption) {
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[active];
      if (option) choose(option);
    }
  }

  return (
    <div className={`select-menu${open ? ' open' : ''}${className ? ` ${className}` : ''}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((next) => !next);
        }}
      >
        <span className="select-value">{selected?.label ?? '请选择'}</span>
        <Icon name="chevron-right" size={15} className="select-chevron" />
      </button>

      <div
        className="select-pop"
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            id={`${listId}-${index}`}
            role="option"
            aria-selected={option.value === value}
            tabIndex={-1}
            className={`select-option${index === active ? ' is-active' : ''}${
              option.value === value ? ' is-selected' : ''
            }`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(option)}
          >
            <span className="select-option-text">
              <span>{option.label}</span>
              {option.hint ? <small>{option.hint}</small> : null}
            </span>
            {option.value === value ? (
              <Icon name="circle-check" size={14} className="select-check" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

