import type { PresenceView } from '@muzradar/shared';
import { absoluteUrl } from '@/lib/config';

export function shouldCenterOnFirstFix(previousView: unknown, centred: boolean): boolean {
  return previousView === null && !centred;
}

export function createListenerElement(view: PresenceView, onSelect: (userId: string) => void, selected = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.userId = view.userId;
  button.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:4px',
    'padding:0',
    'border:0',
    'background:transparent',
    'color:#F4F3FA',
    'font:500 11px Manrope,sans-serif',
    'cursor:pointer',
    'pointer-events:auto',
    `opacity:${view.approx === true ? '0.55' : '1'}`,
  ].join(';');
  button.setAttribute('aria-label', view.track ? `${view.name}: ${view.track.title}, ${view.track.artist}` : `${view.name}: сейчас ничего не играет`);

  const avatar = document.createElement('img');
  avatar.alt = '';
  avatar.src = absoluteUrl(view.mapAvatarUrl) ?? '';
  avatar.style.cssText = `width:44px;height:44px;border-radius:50%;object-fit:cover;background:#6E56CF;border:${selected ? '3px' : '2px'} solid ${selected ? '#C8FF3D' : '#07070C'};box-shadow:0 2px 12px rgba(0,0,0,.45)`;
  if (!view.mapAvatarUrl) avatar.style.display = 'none';

  const fallback = document.createElement('span');
  fallback.textContent = view.name.trim().charAt(0).toUpperCase() || '?';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.style.cssText = `display:${view.mapAvatarUrl ? 'none' : 'flex'};align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:#6E56CF;border:${selected ? '3px' : '2px'} solid ${selected ? '#C8FF3D' : '#07070C'};font-size:20px`;

  const track = document.createElement('span');
  track.textContent = view.track?.title ?? '';
  track.style.cssText = 'max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(7,7,12,.88);border-radius:8px;padding:3px 6px;text-shadow:0 1px 2px #07070C';

  button.append(avatar, fallback, track);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onSelect(view.userId);
  });
  return button;
}
