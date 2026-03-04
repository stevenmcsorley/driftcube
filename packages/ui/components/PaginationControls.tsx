"use client";

export function PaginationControls(props: {
  page: number;
  totalPages: number;
  totalItems: number;
  label?: string;
  onPageChange: (page: number) => void;
}) {
  const canGoBack = props.page > 1;
  const canGoForward = props.page < props.totalPages;

  return (
    <div className="pagination-bar">
      <div className="pagination-copy">
        <span>{props.label ?? "Page"}</span>
        <strong>{props.page} / {props.totalPages}</strong>
        <small>{props.totalItems} total</small>
      </div>

      <div className="pagination-actions">
        <button
          className="switch-pill"
          disabled={!canGoBack}
          onClick={() => props.onPageChange(props.page - 1)}
          type="button"
        >
          Prev
        </button>
        <button
          className="switch-pill"
          disabled={!canGoForward}
          onClick={() => props.onPageChange(props.page + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}
