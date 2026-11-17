// Adapted from SPHERE frontend/src/modules/profile/pages/create-collection/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the study form, a page title, and no loading modal (nothing is uploaded).

import { Helmet } from 'react-helmet-async';
import CreateStudyForm from '../../components/create-study-form';

/** `/studies/new?org=&problem=&revision=&engine=` (`study-builder`). */
export default function CreateStudyPage() {
  return (
    <div className="mx-auto mt-4 w-full max-w-[1100px] px-4">
      <Helmet>
        <title>OpenBinding - New study</title>
      </Helmet>
      <CreateStudyForm />
    </div>
  );
}
