// Adapted from SPHERE frontend/src/modules/pricing/pages/create/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the composition form, and a page title.

import { Helmet } from 'react-helmet-async';
import CreateCompositionForm from '../../components/create-composition-form';

export default function CreateCompositionPage() {
  return (
    <div className="mx-auto mt-4 w-full max-w-[900px] px-4">
      <Helmet>
        <title>OpenBinding - New composition</title>
      </Helmet>
      <CreateCompositionForm />
    </div>
  );
}
