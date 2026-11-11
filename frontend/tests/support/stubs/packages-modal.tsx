// The Packages modal is a CTAN browser (covered at the store level); the page
// only cares that it can report a change and close.
export const packagesModalState = { props: null as { onChanged: (msg: string) => void; onClose: () => void } | null };

export default function PackagesModal(props: { onChanged: (msg: string) => void; onClose: () => void }) {
  packagesModalState.props = props;
  return <div data-modal="packages" />;
}
