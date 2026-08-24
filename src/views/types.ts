/** A mounted screen. Views own their DOM and clean up after themselves. */
export interface View {
  element: HTMLElement;
  /** Called when the route changes away from this view. */
  destroy?(): void;
}
