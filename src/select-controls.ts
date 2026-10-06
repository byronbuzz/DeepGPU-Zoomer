/** Step closed dropdowns without opening the customizable native picker. */
export function setupSelectControls() {
  if (!CSS.supports('selector(select:open)')) return;
  document.querySelectorAll<HTMLSelectElement>('select').forEach(select => {
    select.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (select.multiple || select.size > 1 || select.matches(':disabled, :open')) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const start = select.selectedIndex < 0 ? (direction > 0 ? -1 : select.options.length) : select.selectedIndex;
      for (let index = start + direction; index >= 0 && index < select.options.length; index += direction) {
        const option = select.options[index];
        if (option.matches(':disabled') || option.hidden) continue;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    });
  });
}
