// Monaco, bundled with the application instead of fetched from a CDN. @monaco-editor/react loads Monaco from jsDelivr unless
// it is handed an instance (`loader.config({ monaco })`); here it gets the copy Vite bundles, and the web workers Monaco
// starts are Vite workers served from this origin too. Nothing of the editor is requested from anywhere else. The design
// (sphere-convergence §2.2, C6) replaces SPHERE's CDN loader with this; SPHERE's own editor setup is otherwise the reference.

import { loader } from '@monaco-editor/react';
// The editor's API and its features (find, folding, hover, suggestions), and YAML's highlighting: the only language
// OpenBinding's editors write. Monaco's other languages and their workers are not bundled.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import githubDark from '../../theme/editor-themes/GitHub-Dark.json';
import textmate from '../../theme/editor-themes/Textmate.json';

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

loader.config({ monaco });

/** SPHERE's editor themes (core/theme/editor-themes): Textmate on light pages, GitHub Dark in the dark editor. */
monaco.editor.defineTheme('textmate', textmate as monaco.editor.IStandaloneThemeData);
monaco.editor.defineTheme('github-dark', githubDark as monaco.editor.IStandaloneThemeData);

export { monaco };
