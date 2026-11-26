// Stands in for the native modal dialog and the canvas, which jsdom does not draw.

HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
};

HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
};

HTMLElement.prototype.scrollIntoView = function () {};
