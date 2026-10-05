// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger, type TabsProps } from './tabs';

function Fixture(props: Partial<TabsProps>) {
  return (
    <Tabs {...props}>
      <TabsList aria-label="Sektioner">
        <TabsTrigger value="one">Et</TabsTrigger>
        <TabsTrigger value="two">To</TabsTrigger>
        <TabsTrigger value="three" disabled>
          Tre
        </TabsTrigger>
        <TabsTrigger value="four">Fire</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Indhold et</TabsContent>
      <TabsContent value="two">Indhold to</TabsContent>
      <TabsContent value="three">Indhold tre</TabsContent>
      <TabsContent value="four">Indhold fire</TabsContent>
    </Tabs>
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('Tabs aria', () => {
  it('exposes tablist, tab and tabpanel roles wired together', () => {
    render(<Fixture defaultValue="one" />);
    expect(screen.getByRole('tablist', { name: 'Sektioner' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Indhold et');
    expect(tab('Et')).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab('Et').id);
  });

  it('sets aria-selected and roving tabindex on the active tab only', () => {
    render(<Fixture defaultValue="two" />);
    expect(tab('To')).toHaveAttribute('aria-selected', 'true');
    expect(tab('To')).toHaveAttribute('tabindex', '0');
    for (const n of ['Et', 'Tre', 'Fire']) {
      expect(tab(n)).toHaveAttribute('aria-selected', 'false');
      expect(tab(n)).toHaveAttribute('tabindex', '-1');
    }
  });

  it('hides inactive panels', () => {
    render(<Fixture defaultValue="one" />);
    expect(screen.getByText('Indhold to')).not.toBeVisible();
    expect(screen.getByText('Indhold et')).toBeVisible();
  });

  it('throws a clear error when used outside Tabs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TabsTrigger value="x">x</TabsTrigger>)).toThrow(/Tabs/);
    spy.mockRestore();
  });
});

describe('Tabs keyboard navigation', () => {
  it('ArrowRight moves focus and selection, skipping disabled tabs', async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="one" />);
    tab('Et').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('To')).toHaveFocus();
    expect(tab('To')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('Fire')).toHaveFocus();
    expect(tab('Fire')).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowRight wraps from last to first', async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="four" />);
    tab('Fire').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Et')).toHaveFocus();
    expect(tab('Et')).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowLeft moves back and wraps from first to last', async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="two" />);
    tab('To').focus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Et')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('Fire')).toHaveFocus();
    expect(tab('Fire')).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to the first and last enabled tab', async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="two" />);
    tab('To').focus();
    await user.keyboard('{End}');
    expect(tab('Fire')).toHaveFocus();
    expect(tab('Fire')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(tab('Et')).toHaveFocus();
    expect(tab('Et')).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores other keys', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Fixture defaultValue="one" onValueChange={onValueChange} />);
    tab('Et').focus();
    await user.keyboard('a');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('does not select a disabled tab on click', async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="one" />);
    await user.click(tab('Tre'));
    expect(tab('Et')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Tabs controlled vs uncontrolled', () => {
  it('uncontrolled: switches on click and reports via onValueChange', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Fixture defaultValue="one" onValueChange={onValueChange} />);
    await user.click(tab('To'));
    expect(onValueChange).toHaveBeenCalledWith('two');
    expect(tab('To')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Indhold to');
  });

  it('controlled: does not change on its own, only follows the value prop', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(<Fixture value="one" onValueChange={onValueChange} />);
    await user.click(tab('To'));
    expect(onValueChange).toHaveBeenCalledWith('two');
    expect(tab('Et')).toHaveAttribute('aria-selected', 'true');
    expect(tab('To')).toHaveAttribute('aria-selected', 'false');
    rerender(<Fixture value="two" onValueChange={onValueChange} />);
    expect(tab('To')).toHaveAttribute('aria-selected', 'true');
  });

  it('controlled by parent state works with keyboard navigation', async () => {
    const user = userEvent.setup();
    function Parent() {
      const [v, setV] = useState('one');
      return (
        <>
          <Fixture value={v} onValueChange={setV} />
          <output>{v}</output>
        </>
      );
    }
    render(<Parent />);
    tab('Et').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('status')).toHaveTextContent('two');
    expect(tab('To')).toHaveAttribute('aria-selected', 'true');
  });
});
