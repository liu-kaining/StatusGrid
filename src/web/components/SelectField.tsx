import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

interface SelectOption { value: string; label: string }

/** A select-only combobox: focus stays on the trigger while arrows explore the list. */
export function SelectField({ label, caption = label, value, options, onChange, selectionLabel }: {
  label: string; caption?: string; value: string; options: SelectOption[];
  onChange: (value: string) => void; selectionLabel?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex((option) => option.value === value);
  const selectedLabel = selectionLabel ?? options[selected]?.label ?? '暂无选项';
  const activeIndex = Math.min(active, options.length - 1);
  const openMenu = (index = selected >= 0 ? selected : 0) => { setActive(index); setOpen(true); trigger.current?.focus(); };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value); setOpen(false); trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex); else openMenu();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); openMenu(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else setActive(Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1))));
    }
  };
  return <div className="select-field" ref={root}>
    <label htmlFor={id}>{caption}</label>
    <button type="button" id={id} ref={trigger} role="combobox" aria-label={label} aria-describedby={`${id}-value`}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${id}-menu` : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
      disabled={!options.length} onKeyDown={keyDown} onBlur={() => setOpen(false)}
      onClick={() => { if (open) setOpen(false); else openMenu(); }}>
      <span id={`${id}-value`} title={selectedLabel}>{selectedLabel}</span><span className="select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="select-menu" id={`${id}-menu`} ref={menu} role="listbox" aria-label={`${label}选项`}>
      {options.map((option, index) => <div id={`${id}-option-${index}`} key={option.value} role="option"
        aria-selected={option.value === value} data-active={activeIndex === index}
        onPointerMove={() => setActive(index)} onPointerDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span><span className="select-check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
      </div>)}
    </div>}
  </div>;
}
