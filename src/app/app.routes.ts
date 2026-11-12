import { Routes } from '@angular/router';

import { CapturePage } from './capture-page/capture-page';

export const routes: Routes = [
  { path: 's/:sessionId', component: CapturePage },
  { path: '', component: CapturePage }, // modo desarrollo, sin sesión
  { path: '**', redirectTo: '' },
];
