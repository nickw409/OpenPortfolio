// @vitest-environment jsdom

import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '@frontend/stores/ui-store';
import { ThemeProvider } from './theme-provider';

describe('ThemeProvider', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    useUiStore.setState({ theme: 'system', sidebarCollapsed: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits data-theme when theme is "system"', () => {
    render(<ThemeProvider />);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('sets data-theme="light" when theme is "light"', () => {
    useUiStore.setState({ theme: 'light' });
    render(<ThemeProvider />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('sets data-theme="dark" when theme is "dark"', () => {
    useUiStore.setState({ theme: 'dark' });
    render(<ThemeProvider />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('updates the attribute when theme changes', () => {
    render(<ThemeProvider />);
    act(() => useUiStore.setState({ theme: 'dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => useUiStore.setState({ theme: 'system' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
