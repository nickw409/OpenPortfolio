// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from './ui-store';

describe('useUiStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.persist.clearStorage();
    useUiStore.setState({ theme: 'system', sidebarCollapsed: false });
  });

  it('exposes a default theme of "system"', () => {
    expect(useUiStore.getState().theme).toBe('system');
  });

  it('exposes a default sidebarCollapsed of false', () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setTheme updates the theme', () => {
    useUiStore.getState().setTheme('dark');
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('toggleSidebar flips sidebarCollapsed', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('persists state to localStorage', async () => {
    useUiStore.getState().setTheme('light');
    useUiStore.getState().toggleSidebar();
    // persist middleware writes synchronously after state change
    const raw = localStorage.getItem('openportfolio-ui-v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.theme).toBe('light');
    expect(parsed.state.sidebarCollapsed).toBe(true);
  });
});
