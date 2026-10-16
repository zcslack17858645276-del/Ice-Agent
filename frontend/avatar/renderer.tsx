import type { ReactNode } from 'react';
import type { AvatarAsset, AvatarExpression, PetState } from './types';

export type AvatarRenderProps = {
  state: PetState;
  expression: AvatarExpression;
  asset: AvatarAsset;
  animationEnabled: boolean;
  onAssetError: (message: string) => void;
};

export type AvatarRenderer = (props: AvatarRenderProps) => ReactNode;

export const StaticAvatarRenderer: AvatarRenderer = function StaticAvatarRenderer({
  state,
  expression,
  asset,
  animationEnabled,
  onAssetError
}: AvatarRenderProps) {
  return (
    <img
      className={`avatar-image state-${state.toLowerCase()} expression-${expression.toLowerCase()}${animationEnabled ? '' : ' animation-disabled'}`}
      src={asset.src}
      alt={`${asset.name}, ${state.toLowerCase()} state`}
      draggable={false}
      onError={(event) => {
        const image = event.currentTarget;
        if (image.src !== asset.fallbackSrc) {
          image.src = asset.fallbackSrc;
          onAssetError(`Avatar asset failed to load for ${state}; showing fallback.`);
        } else {
          onAssetError(`Avatar asset and fallback failed to load for ${asset.name}.`);
        }
      }}
    />
  );
};
