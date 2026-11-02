'use strict';

class Catalog {
    constructor(books = []) {
        this.books = [...books];
    }

    list() {
        return [...this.books];
    }

    addBook(book) {
        this.books.push({ ...book });
        return this.findById(book.id);
    }

    findById(id) {
        return this.books.find((book) => book.id === id);
    }

    findByAuthor(author) {
        return this.books.filter((book) => book.author === author);
    }

    removeBook(id) {
        const index = this.books.findIndex((book) => book.id === id);
        if (index === -1) return false;
        this.books.splice(index, 1);
        return true;
    }
}

module.exports = { Catalog };
