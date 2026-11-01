import type {AndroidNode,TargetContent} from './types.js';

/**
 * The fields that say *which* node the caller acted on, without its geometry.
 * Node ids are structural (window/package/parent/resource/index), so a list
 * that reflows - a row inserted above, a scroll - keeps the id but breaks the
 * fingerprint, which also hashes bounds and child signatures.
 */
export function targetContent(n:AndroidNode):TargetContent {
  return {className:n.className,package:n.package,resourceId:n.resourceId,text:n.text,description:n.description};
}

/**
 * True when the fresh node still holds the content the caller saw. Geometry is
 * deliberately not compared: the action uses the fresh bounds, so a node that
 * merely moved is the same target, while changed text, description, class,
 * resource id or package is a different one and stays a rejection.
 */
export function sameTargetContent(content:TargetContent,node:AndroidNode):boolean {
  return content.className===node.className&&content.package===node.package
    &&content.resourceId===node.resourceId&&content.text===node.text&&content.description===node.description;
}
