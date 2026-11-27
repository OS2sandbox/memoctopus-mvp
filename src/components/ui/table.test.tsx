// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Table,
  TableBody,
  TableCell,
  TableEmptyRow,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

describe('Table', () => {
  it('renders semantic table structure with column headers', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Navn</TableHead>
            <TableHead>Rolle</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Anna</TableCell>
            <TableCell>bruger</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Navn' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('cell', { name: 'Anna' })).toBeInTheDocument();
  });

  it('lets TableHead override scope for row headers', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead scope="row">Anna</TableHead>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('rowheader', { name: 'Anna' })).toHaveAttribute('scope', 'row');
  });

  it('merges custom classes and forwards refs', () => {
    render(
      <Table className="custom-table">
        <TableBody />
      </Table>,
    );
    expect(screen.getByRole('table')).toHaveClass('custom-table');
  });

  it('renders an empty-state row spanning all columns with a Danish default', () => {
    render(
      <Table>
        <TableBody>
          <TableEmptyRow colSpan={3} />
        </TableBody>
      </Table>,
    );
    const cell = screen.getByRole('cell', { name: 'Ingen data' });
    expect(cell).toHaveAttribute('colspan', '3');
  });

  it('renders custom empty-state content', () => {
    render(
      <Table>
        <TableBody>
          <TableEmptyRow colSpan={2}>Ingen medlemmer</TableEmptyRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByText('Ingen medlemmer')).toBeInTheDocument();
  });
});
